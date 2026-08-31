import { describe, expect, it } from 'vitest';
import {
  InMemoryPublicationRepository,
  PublicationError,
  PublicationService,
  type PublicationRepository,
  type PublicationState,
} from '../src/application/publication.service.js';
import { sanitizeRichText } from '../src/domain/rich-text.js';

const OWNER = '01990f24-2ba2-7000-8000-000000000001';
const ADMIN = '01990f24-2ba2-7000-8000-000000000002';
const USER = '01990f24-2ba2-7000-8000-000000000003';
const NOW = new Date('2026-08-31T12:00:00.000Z');

function setup() {
  const repository = new InMemoryPublicationRepository();
  let sequence = 0;
  const service = new PublicationService({
    repository,
    now: () => NOW,
    id: () => `01990f24-2ba2-7000-8000-${String(++sequence).padStart(12, '0')}`,
  });
  return { repository, service };
}

async function publishedPackage(service: PublicationService) {
  const draft = await service.createPackageDraft({
    name: '100元套餐', amountMinor: 10_000n, currency: 'CNY', points: 100_000n,
    bonusPoints: 5_000n, purchaseLimit: 2, validityDays: 365, sortOrder: 10,
  }, OWNER);
  return service.publishPackage(draft.id, draft.revision, OWNER);
}

describe('recharge package publication', () => {
  it('keeps published versions immutable when a later draft is edited', async () => {
    const { service } = setup();
    const published = await publishedPackage(service);
    const draft = await service.createPackageDraftFrom(published.id, { bonusPoints: 10_000n }, OWNER);
    await service.updatePackageDraft(draft.id, draft.revision, { bonusPoints: 20_000n }, OWNER);
    expect((await service.getPackageVersion(published.id)).bonusPoints).toBe(5_000n);
  });

  it('stores an immutable package snapshot for a purchase', async () => {
    const { service } = setup();
    const published = await publishedPackage(service);
    const purchaseId = '01990f24-2ba2-7000-8000-000000000020';
    const snapshot = await service.capturePackagePurchase(purchaseId, published.id, USER);
    const later = await service.createPackageDraftFrom(published.id, { bonusPoints: 99_000n }, OWNER);
    await service.publishPackage(later.id, later.revision, OWNER);
    expect(snapshot).toMatchObject({
      purchaseId, packageVersionId: published.id, amountMinor: 10_000n,
      points: 100_000n, bonusPoints: 5_000n, buyerId: USER,
    });
    expect(await service.getPackagePurchase(purchaseId)).toEqual(snapshot);
  });

  it('rejects non-v7 purchase ids and non-CNY package currency', async () => {
    const { service } = setup();
    expect(() => service.createPackageDraft({
      name: 'USD', amountMinor: 100n, currency: 'USD', points: 1n, bonusPoints: 0n,
      purchaseLimit: null, validityDays: null, sortOrder: 0,
    }, ADMIN)).toThrow('INVALID_PACKAGE');
    const published = await publishedPackage(service);
    await expect(service.capturePackagePurchase('purchase-not-uuidv7', published.id, USER))
      .rejects.toMatchObject({ code: 'INVALID_PURCHASE_ID' });
    await expect(service.capturePackagePurchase('01990f24-2ba2-7000-8000-000000000024', published.id, '01990f24-2ba2-4000-8000-000000000099'))
      .rejects.toMatchObject({ code: 'INVALID_BUYER_ID' });
  });

  it('rejects non-v7 actor identities before persistence', () => {
    const { service } = setup();
    expect(() => service.createPackageDraft({ name: 'bad actor', amountMinor: 100n, currency: 'CNY', points: 1n, bonusPoints: 0n, purchaseLimit: null, validityDays: null, sortOrder: 0 }, '01990f24-2ba2-4000-8000-000000000002'))
      .toThrow('INVALID_ACTOR_ID');
  });

  it('re-reads a concurrent purchase insert and returns or rejects it idempotently', async () => {
    const existing = {
      purchaseId: '01990f24-2ba2-7000-8000-000000000021', packageVersionId: '01990f24-2ba2-7000-8000-000000000010', buyerId: USER,
      name: 'stable', amountMinor: 100n, currency: 'CNY', points: 1n, bonusPoints: 0n,
      purchaseLimit: null, validityDays: null, capturedAt: NOW,
    };
    const state = emptyPublicationState(); state.purchases.set(existing.purchaseId, existing);
    const repository: PublicationRepository = {
      transact: () => Promise.reject(new PublicationError('VERSION_CONFLICT')),
      snapshot: () => Promise.resolve(structuredClone(state)),
    };
    const service = new PublicationService({ repository, now: () => NOW });
    await expect(service.capturePackagePurchase(existing.purchaseId, existing.packageVersionId, USER)).resolves.toEqual(existing);
    await expect(service.capturePackagePurchase(existing.purchaseId, existing.packageVersionId, '01990f24-2ba2-7000-8000-000000000099'))
      .rejects.toMatchObject({ code: 'PURCHASE_IDEMPOTENCY_CONFLICT' });
  });

  it('rejects purchasing a draft or retired package', async () => {
    const { service } = setup();
    const draft = await service.createPackageDraft({
      name: 'draft', amountMinor: 100n, currency: 'CNY', points: 1n, bonusPoints: 0n,
      purchaseLimit: null, validityDays: null, sortOrder: 0,
    }, ADMIN);
    await expect(service.capturePackagePurchase('01990f24-2ba2-7000-8000-000000000022', draft.id, USER))
      .rejects.toMatchObject({ code: 'PACKAGE_NOT_ACTIVE' });
    const published = await service.publishPackage(draft.id, draft.revision, ADMIN);
    const retired = await service.retirePackage(published.id, published.revision, ADMIN);
    await expect(service.capturePackagePurchase('01990f24-2ba2-7000-8000-000000000023', retired.id, USER))
      .rejects.toMatchObject({ code: 'PACKAGE_NOT_ACTIVE' });
  });

  it('allows exactly one concurrent publish with the same revision guard', async () => {
    const { service } = setup();
    const draft = await service.createPackageDraft({
      name: '并发套餐', amountMinor: 100n, currency: 'CNY', points: 1n, bonusPoints: 0n,
      purchaseLimit: null, validityDays: null, sortOrder: 0,
    }, ADMIN);
    const results = await Promise.allSettled([
      service.publishPackage(draft.id, draft.revision, ADMIN),
      service.publishPackage(draft.id, draft.revision, ADMIN),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejection = results.find((result) => result.status === 'rejected');
    expect(rejection).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
  });

  it('allows only one of two drafts based on the same published package to publish', async () => {
    const { service } = setup();
    const published = await publishedPackage(service);
    const first = await service.createPackageDraftFrom(published.id, { name: 'first' }, ADMIN);
    const second = await service.createPackageDraftFrom(published.id, { name: 'second' }, ADMIN);
    const results = await Promise.allSettled([
      service.publishPackage(first.id, first.revision, ADMIN),
      service.publishPackage(second.id, second.revision, ADMIN),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
  });

  it('publishes the package and its outbox event atomically', async () => {
    const { repository, service } = setup();
    const draft = await service.createPackageDraft({
      name: '原子套餐', amountMinor: 100n, currency: 'CNY', points: 1n, bonusPoints: 0n,
      purchaseLimit: null, validityDays: null, sortOrder: 0,
    }, ADMIN);
    repository.failNextOutboxWrite();
    await expect(service.publishPackage(draft.id, draft.revision, ADMIN)).rejects.toThrow('OUTBOX_WRITE_FAILED');
    expect((await service.getPackageVersion(draft.id)).status).toBe('DRAFT');
    expect(repository.outboxEvents()).toHaveLength(0);
  });
});

function emptyPublicationState(): PublicationState {
  return {
    packages: new Map(), purchases: new Map(), entries: new Map(), content: new Map(), placements: new Map(),
    slotRevisions: new Map(), categories: new Map(), settings: new Map(), flags: new Map(), outbox: [],
  };
}

describe('CMS publication', () => {
  it('enforces the draft-published-retired state machine dynamically', async () => {
    const { service } = setup();
    const draft = await service.createPackageDraft({ name: 'state', amountMinor: 100n, currency: 'CNY', points: 1n, bonusPoints: 0n, purchaseLimit: null, validityDays: null, sortOrder: 0 }, ADMIN);
    await expect(service.retirePackage(draft.id, draft.revision, ADMIN)).rejects.toMatchObject({ code: 'VERSION_NOT_PUBLISHED' });
    const published = await service.publishPackage(draft.id, draft.revision, ADMIN);
    await expect(service.updatePackageDraft(published.id, published.revision, { name: 'forbidden' }, ADMIN)).rejects.toMatchObject({ code: 'PUBLISHED_VERSION_IMMUTABLE' });
    const retired = await service.retirePackage(published.id, published.revision, ADMIN);
    await expect(service.retirePackage(retired.id, retired.revision, ADMIN)).rejects.toMatchObject({ code: 'VERSION_NOT_PUBLISHED' });
  });
  it('publishes, rolls back by publishing a new copy, and never mutates old versions', async () => {
    const { repository, service } = setup();
    const entry = await service.createContentEntry({ kind: 'ANNOUNCEMENT', key: 'launch' }, ADMIN);
    const firstDraft = await service.createContentDraft(entry.id, {
      title: 'v1', summary: 'first', bodyHtml: '<p>first</p>', sortOrder: 1,
    }, ADMIN);
    const first = await service.publishContent(firstDraft.id, firstDraft.revision, ADMIN);
    const secondDraft = await service.createContentDraft(entry.id, {
      title: 'v2', summary: 'second', bodyHtml: '<p>second</p>', sortOrder: 1,
    }, ADMIN);
    await service.publishContent(secondDraft.id, secondDraft.revision, ADMIN);
    const context = { traceId: 'fedcba9876543210fedcba9876543210', correlationId: '01990f24-2ba2-7000-8000-000000000090' };
    const rollback = await service.rollbackContent(entry.id, first.id, ADMIN, context);
    expect(rollback.id).not.toBe(first.id);
    expect(rollback.title).toBe('v1');
    expect((await service.getContentVersion(first.id)).bodyHtml).toBe('<p>first</p>');
    expect(repository.outboxEvents().at(-1)).toMatchObject(context);
  });

  it('uses optimistic concurrency for draft edits and publication', async () => {
    const { service } = setup();
    const entry = await service.createContentEntry({ kind: 'HELP', key: 'getting-started' }, ADMIN);
    const draft = await service.createContentDraft(entry.id, {
      title: 'Start', summary: '', bodyHtml: '<p>hello</p>', sortOrder: 0,
    }, ADMIN);
    const edited = await service.updateContentDraft(draft.id, draft.revision, { title: 'Edited' }, ADMIN);
    await expect(service.publishContent(draft.id, draft.revision, ADMIN))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    expect((await service.publishContent(edited.id, edited.revision, ADMIN)).status).toBe('PUBLISHED');
  });

  it('reorders banners with a collection revision and returns only active placements', async () => {
    const { service } = setup();
    const ids: string[] = [];
    for (const key of ['one', 'two']) {
      const entry = await service.createContentEntry({ kind: 'BANNER', key }, ADMIN);
      const draft = await service.createContentDraft(entry.id, {
        title: key, summary: '', bodyHtml: '<p>banner</p>', sortOrder: 0,
      }, ADMIN);
      const version = await service.publishContent(draft.id, draft.revision, ADMIN);
      ids.push((await service.placeBanner({
        contentVersionId: version.id, slot: 'HOME_HERO', sortOrder: ids.length,
        expectedRevision: ids.length, activeFrom: null, activeUntil: null,
      }, ADMIN)).id);
    }
    const reordered = await service.reorderBanners('HOME_HERO', 2, [...ids].reverse(), ADMIN);
    expect(reordered.revision).toBe(3);
    expect((await service.listPublicBanners('HOME_HERO', NOW)).map((item) => item.placement.id))
      .toEqual([...ids].reverse());
    await expect(service.reorderBanners('HOME_HERO', 2, ids, ADMIN))
      .rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });

  it('serializes concurrent banner placement and reorder with one collection revision', async () => {
    const { service } = setup();
    const versions = [];
    for (const key of ['existing', 'new']) {
      const entry = await service.createContentEntry({ kind: 'BANNER', key }, ADMIN);
      const draft = await service.createContentDraft(entry.id, { title: key, summary: '', bodyHtml: '<p>x</p>', sortOrder: 0 }, ADMIN);
      versions.push(await service.publishContent(draft.id, draft.revision, ADMIN));
    }
    const existingVersion = versions[0]; const newVersion = versions[1];
    if (existingVersion === undefined || newVersion === undefined) throw new Error('missing banner versions');
    const first = await service.placeBanner({ contentVersionId: existingVersion.id, slot: 'HOME_HERO', sortOrder: 0, expectedRevision: 0, activeFrom: null, activeUntil: null }, ADMIN);
    const results = await Promise.allSettled([
      service.reorderBanners('HOME_HERO', 1, [first.id], ADMIN),
      service.placeBanner({ contentVersionId: newVersion.id, slot: 'HOME_HERO', sortOrder: 1, expectedRevision: 1, activeFrom: null, activeUntil: null }, ADMIN),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
  });

  it('returns public announcements and help content only after publication', async () => {
    const { service } = setup();
    const announcement = await service.createContentEntry({ kind: 'ANNOUNCEMENT', key: 'notice' }, ADMIN);
    const draft = await service.createContentDraft(announcement.id, {
      title: 'Notice', summary: '', bodyHtml: '<p>safe</p>', sortOrder: 2,
    }, ADMIN);
    expect(await service.listPublicContent('ANNOUNCEMENT', NOW)).toEqual([]);
    await service.publishContent(draft.id, draft.revision, ADMIN);
    expect((await service.listPublicContent('ANNOUNCEMENT', NOW)).map((item) => item.title)).toEqual(['Notice']);
  });

  it('rejects invalid content windows and category links outside active HELP content', async () => {
    const { service } = setup();
    const inactive = await service.createHelpCategory({ key: 'disabled', name: 'Disabled', sortOrder: 0, active: false }, ADMIN);
    const help = await service.createContentEntry({ kind: 'HELP', key: 'hidden-help' }, ADMIN);
    await expect(service.createContentDraft(help.id, {
      title: 'hidden', summary: '', bodyHtml: '<p>x</p>', sortOrder: 0, helpCategoryId: inactive.id,
    }, ADMIN)).rejects.toMatchObject({ code: 'HELP_CATEGORY_NOT_ACTIVE' });
    const announcement = await service.createContentEntry({ kind: 'ANNOUNCEMENT', key: 'wrong-category' }, ADMIN);
    await expect(service.createContentDraft(announcement.id, {
      title: 'wrong', summary: '', bodyHtml: '<p>x</p>', sortOrder: 0, helpCategoryId: inactive.id,
    }, ADMIN)).rejects.toMatchObject({ code: 'HELP_CATEGORY_NOT_ALLOWED' });
    await expect(service.createContentDraft(announcement.id, {
      title: 'window', summary: '', bodyHtml: '<p>x</p>', sortOrder: 0,
      activeFrom: new Date('2026-09-02T00:00:00Z'), activeUntil: new Date('2026-09-01T00:00:00Z'),
    }, ADMIN)).rejects.toMatchObject({ code: 'INVALID_CONTENT' });
  });
});

describe('publication input safety', () => {
  it.each([
    '<script>alert(1)</script>',
    '<img src="https://safe.example/x.png" onerror="alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<iframe src="https://evil.example/embed"></iframe>',
  ])('rejects dangerous rich text: %s', (html) => {
    expect(() => sanitizeRichText(html, { trustedIframeOrigins: ['https://media.example.cn'] }))
      .toThrow(PublicationError);
  });

  it('removes non-allowlisted benign markup and permits a trusted iframe', () => {
    expect(sanitizeRichText(
      '<p class="ignored">ok <strong>bold</strong></p><aside>note</aside><iframe src="https://media.example.cn/embed/1" allowfullscreen></iframe>',
      { trustedIframeOrigins: ['https://media.example.cn'] },
    )).toBe('<p>ok <strong>bold</strong></p>note<iframe src="https://media.example.cn/embed/1" allowfullscreen></iframe>');
  });

  it('stores either public configuration or a KMS reference, never a raw secret', async () => {
    const { service } = setup();
    await expect(service.createSystemSettingDraft({
      key: 'wechat.apiSecret', publicValue: 'plain-secret',
    }, ADMIN)).rejects.toMatchObject({ code: 'RAW_SECRET_FORBIDDEN' });
    await expect(service.createSystemSettingDraft({
      key: 'wechat.apiSecret', kmsSecretReferenceId: 'not-a-kms-reference',
    }, ADMIN)).rejects.toMatchObject({ code: 'INVALID_KMS_REFERENCE' });
    const draft = await service.createSystemSettingDraft({
      key: 'wechat.apiSecret', kmsSecretReferenceId: 'kms://operations/wechat-api-secret',
    }, ADMIN);
    expect(draft).toMatchObject({ publicValue: null, kmsSecretReferenceId: 'kms://operations/wechat-api-secret' });
    await expect(service.createSystemSettingDraft({
      key: 'wechat.apiKey', publicValue: 'plain-secret',
    }, ADMIN)).rejects.toMatchObject({ code: 'RAW_SECRET_FORBIDDEN' });
  });

  it('publishes settings with a revision guard and keeps the published value immutable', async () => {
    const { service } = setup();
    const draft = await service.createSystemSettingDraft({ key: 'site.publicConfig', publicValue: { theme: 'dark' } }, ADMIN);
    const edited = await service.updateSystemSettingDraft(draft.id, draft.revision, { publicValue: { theme: 'light' } }, ADMIN);
    const published = await service.publishSystemSetting(edited.id, edited.revision, ADMIN);
    await expect(service.updateSystemSettingDraft(published.id, published.revision, { publicValue: { theme: 'other' } }, ADMIN))
      .rejects.toMatchObject({ code: 'PUBLISHED_VERSION_IMMUTABLE' });
    expect(await service.getSystemSettingVersion(published.id)).toMatchObject({ status: 'PUBLISHED', publicValue: { theme: 'light' } });
  });

  it('applies strict per-key public configuration schemas and recursively rejects secrets', async () => {
    const { service } = setup();
    await expect(service.createSystemSettingDraft({ key: 'site.publicConfig', publicValue: { theme: 'dark', apiSecret: 'leak' } }, ADMIN))
      .rejects.toMatchObject({ code: 'INVALID_PUBLIC_CONFIGURATION' });
    await expect(service.createSystemSettingDraft({ key: 'site.publicConfig', publicValue: { theme: 'dark', nested: { token: 'leak' } } }, ADMIN))
      .rejects.toMatchObject({ code: 'INVALID_PUBLIC_CONFIGURATION' });
    await expect(service.createSystemSettingDraft({ key: 'site.publicConfig', publicValue: { theme: 'dark', privateKey: '-----BEGIN PRIVATE KEY-----' } }, ADMIN))
      .rejects.toMatchObject({ code: 'INVALID_PUBLIC_CONFIGURATION' });
    await expect(service.createSystemSettingDraft({ key: 'site.publicConfig', publicValue: { theme: 'dark', unknown: true } }, ADMIN))
      .rejects.toMatchObject({ code: 'INVALID_PUBLIC_CONFIGURATION' });
    await expect(service.createSystemSettingDraft({ key: 'site.publicConfig', publicValue: { theme: 'light', locale: 'zh-CN', registrationEnabled: true } }, ADMIN))
      .resolves.toMatchObject({ publicValue: { theme: 'light', locale: 'zh-CN', registrationEnabled: true } });
  });

  it.each([
    'https://user:password@cdn.example.com/assets',
    'https://cdn.example.com/assets?api_key=leak',
    'https://cdn.example.com/assets?token=leak',
    'https://cdn.example.com/assets#private',
    'http://cdn.example.com/assets',
  ])('rejects unsafe public URLs: %s', async (url) => {
    const { service } = setup();
    await expect(service.createSystemSettingDraft({ key: 'cdn.publicBaseUrl', publicValue: { url } }, ADMIN))
      .rejects.toMatchObject({ code: 'INVALID_PUBLIC_CONFIGURATION' });
    await expect(service.createSystemSettingDraft({ key: 'cdn.publicBaseUrl', publicValue: { url: 'https://cdn.example.com/assets' } }, ADMIN))
      .resolves.toMatchObject({ publicValue: { url: 'https://cdn.example.com/assets' } });
  });

  it('publishes feature flags with optimistic concurrency and transaction outbox', async () => {
    const { repository, service } = setup();
    const draft = await service.createFeatureFlagDraft({ flagKey: 'new-workbench', enabled: false, rules: { percent: 0 } }, ADMIN);
    repository.failNextOutboxWrite();
    await expect(service.publishFeatureFlag(draft.id, draft.revision, ADMIN)).rejects.toThrow('OUTBOX_WRITE_FAILED');
    expect(await service.getFeatureFlagVersion(draft.id)).toMatchObject({ status: 'DRAFT', revision: 0 });
    const results = await Promise.allSettled([
      service.publishFeatureFlag(draft.id, draft.revision, ADMIN),
      service.publishFeatureFlag(draft.id, draft.revision, ADMIN),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { code: 'VERSION_CONFLICT' } });
  });
});
