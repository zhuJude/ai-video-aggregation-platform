import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryPublicationRepository,
  PublicationService,
} from '../src/application/publication.service.js';
import { OperationsHttpModule } from '../src/http/operations-http.module.js';

const ADMIN = '01990f24-2ba2-7000-8000-000000000002';

function service() {
  let sequence = 0;
  return new PublicationService({
    repository: new InMemoryPublicationRepository(),
    now: () => new Date('2026-08-31T12:00:00.000Z'),
    id: () => `01990f24-2ba2-7000-8000-${String(++sequence).padStart(12, '0')}`,
  });
}

describe('operations HTTP boundary', () => {
  it('derives the admin from raw request authentication and ignores a body principal', async () => {
    const publication = service();
    const http = new OperationsHttpModule({
      publication,
      adminAuthenticator: {
        authenticate: (request) =>
          Promise.resolve(
            request.headers.authorization === 'Bearer valid'
              ? { adminId: ADMIN, role: 'ADMIN' as const, permissions: ['operations:write'] }
              : null,
          ),
      },
    });
    const response = await http.handle({
      method: 'POST',
      path: '/admin/v1/recharge-packages/drafts',
      headers: { authorization: 'Bearer valid' },
      body: {
        adminId: '01990f24-2ba2-7000-8000-999999999999',
        name: '真实套餐',
        amountMinor: '10000',
        currency: 'CNY',
        points: '100000',
        bonusPoints: '5000',
        purchaseLimit: 1,
        validityDays: 30,
        sortOrder: 0,
      },
    });
    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ createdBy: ADMIN });
  });

  it('rejects unauthenticated and unauthorized admin mutations with stable errors', async () => {
    const publication = service();
    const unauthenticated = new OperationsHttpModule({
      publication,
      adminAuthenticator: { authenticate: () => Promise.resolve(null) },
    });
    expect(
      await unauthenticated.handle({
        method: 'POST',
        path: '/admin/v1/recharge-packages/drafts',
        body: {},
      }),
    ).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED', retryable: false } });
    const viewer = new OperationsHttpModule({
      publication,
      adminAuthenticator: {
        authenticate: () => Promise.resolve({ adminId: ADMIN, role: 'VIEWER', permissions: [] }),
      },
    });
    expect(
      await viewer.handle({ method: 'POST', path: '/admin/v1/recharge-packages/drafts', body: {} }),
    ).toMatchObject({ status: 403, body: { code: 'FORBIDDEN', retryable: false } });
  });

  it('offers preview/publish/retire/reorder admin routes and public read-only routes', async () => {
    const publication = service();
    const http = new OperationsHttpModule({
      publication,
      adminAuthenticator: {
        authenticate: () =>
          Promise.resolve({ adminId: ADMIN, role: 'OWNER', permissions: ['operations:write'] }),
      },
    });
    const draft = await http.handle({
      method: 'POST',
      path: '/admin/v1/recharge-packages/drafts',
      body: {
        name: '套餐',
        amountMinor: '100',
        currency: 'CNY',
        points: '1',
        bonusPoints: '0',
        purchaseLimit: null,
        validityDays: null,
        sortOrder: 0,
      },
    });
    const version = draft.body as { id: string; revision: number };
    expect(
      (
        await http.handle({
          method: 'GET',
          path: `/admin/v1/recharge-packages/${version.id}/preview`,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await http.handle({
          method: 'POST',
          path: `/admin/v1/recharge-packages/${version.id}/publish`,
          body: { expectedRevision: version.revision },
        })
      ).status,
    ).toBe(200);
    const publicPackages = await http.handle({ method: 'GET', path: '/v1/recharge-packages' });
    expect(publicPackages.status).toBe(200);
    expect(publicPackages.body).toMatchObject([{ name: '套餐', active: true }]);
    expect(
      await http.handle({ method: 'POST', path: '/v1/recharge-packages', body: {} }),
    ).toMatchObject({ status: 404, body: { code: 'ROUTE_NOT_FOUND' } });
  });

  it('maps validation, not-found and version conflict to stable HTTP errors', async () => {
    const publication = service();
    const http = new OperationsHttpModule({
      publication,
      adminAuthenticator: {
        authenticate: () =>
          Promise.resolve({ adminId: ADMIN, role: 'ADMIN', permissions: ['operations:write'] }),
      },
    });
    expect(
      await http.handle({ method: 'POST', path: '/admin/v1/recharge-packages/drafts', body: {} }),
    ).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect(
      await http.handle({
        method: 'GET',
        path: '/admin/v1/recharge-packages/01990f24-2ba2-7000-8000-000000009999/preview',
      }),
    ).toMatchObject({ status: 404, body: { code: 'VERSION_NOT_FOUND' } });
  });

  it.each(['---', '550e8400-e29b-41d4-a716-446655440000'])(
    'rejects invalid path UUID before application access: %s',
    async (id) => {
      const http = new OperationsHttpModule({
        publication: service(),
        adminAuthenticator: {
          authenticate: () =>
            Promise.resolve({ adminId: ADMIN, role: 'ADMIN', permissions: ['operations:write'] }),
        },
      });
      const response = await http.handle({
        method: 'GET',
        path: `/admin/v1/recharge-packages/${id}/preview`,
      });
      expect(response).toMatchObject({
        status: 400,
        body: { code: 'INVALID_REQUEST', retryable: false },
      });
      expect((response.body as { traceId: string }).traceId).toMatch(/^[a-f0-9]{32}$/);
    },
  );

  it.each(['---', '550e8400-e29b-41d4-a716-446655440000'])(
    'rejects every malformed body UUID before application access: %s',
    async (id) => {
      const publication = service();
      const rollback = vi.spyOn(publication, 'rollbackContent');
      const reorder = vi.spyOn(publication, 'reorderBanners');
      const createDraft = vi.spyOn(publication, 'createContentDraft');
      const updateDraft = vi.spyOn(publication, 'updateContentDraft');
      const http = new OperationsHttpModule({
        publication,
        adminAuthenticator: {
          authenticate: () =>
            Promise.resolve({ adminId: ADMIN, role: 'ADMIN', permissions: ['operations:write'] }),
        },
      });
      const valid = '01990f24-2ba2-7000-8000-000000000099';
      const requests = [
        {
          method: 'POST',
          path: `/admin/v1/content-entries/${valid}/rollback`,
          body: { targetVersionId: id },
        },
        {
          method: 'POST',
          path: '/admin/v1/banners/HOME_HERO/reorder',
          body: { expectedRevision: 0, orderedPlacementIds: [id] },
        },
        {
          method: 'POST',
          path: `/admin/v1/content-entries/${valid}/drafts`,
          body: { title: 'x', summary: '', bodyHtml: '<p>x</p>', sortOrder: 0, helpCategoryId: id },
        },
        {
          method: 'PATCH',
          path: `/admin/v1/content-versions/${valid}/draft`,
          body: { expectedRevision: 0, helpCategoryId: id },
        },
      ];
      for (const request of requests) {
        const response = await http.handle(request);
        expect(response).toMatchObject({
          status: 400,
          body: { code: 'INVALID_REQUEST', retryable: false },
        });
        expect((response.body as { traceId: string }).traceId).toMatch(/^[a-f0-9]{32}$/);
      }
      expect(rollback).not.toHaveBeenCalled();
      expect(reorder).not.toHaveBeenCalled();
      expect(createDraft).not.toHaveBeenCalled();
      expect(updateDraft).not.toHaveBeenCalled();
    },
  );

  it('keeps omitted draft fields unchanged and emits JSON-safe decimal strings', async () => {
    const publication = service();
    const http = new OperationsHttpModule({
      publication,
      adminAuthenticator: {
        authenticate: () =>
          Promise.resolve({ adminId: ADMIN, role: 'ADMIN', permissions: ['operations:write'] }),
      },
    });
    const created = await http.handle({
      method: 'POST',
      path: '/admin/v1/recharge-packages/drafts',
      body: {
        name: 'before',
        amountMinor: '10000',
        currency: 'CNY',
        points: '100000',
        bonusPoints: '5000',
        purchaseLimit: 2,
        validityDays: 30,
        sortOrder: 4,
      },
    });
    const draft = created.body as { id: string; revision: number };
    const edited = await http.handle({
      method: 'PATCH',
      path: `/admin/v1/recharge-packages/${draft.id}/draft`,
      body: { expectedRevision: draft.revision, name: 'after' },
    });
    expect(edited.body).toMatchObject({
      name: 'after',
      amountMinor: '10000',
      points: '100000',
      bonusPoints: '5000',
      purchaseLimit: 2,
      validityDays: 30,
      sortOrder: 4,
    });
    expect(() => JSON.stringify(edited.body)).not.toThrow();
  });

  it('creates a next draft from a published version and rejects non-CNY over HTTP', async () => {
    const publication = service();
    const http = new OperationsHttpModule({
      publication,
      adminAuthenticator: {
        authenticate: () =>
          Promise.resolve({ adminId: ADMIN, role: 'ADMIN', permissions: ['operations:write'] }),
      },
    });
    const usd = await http.handle({
      method: 'POST',
      path: '/admin/v1/recharge-packages/drafts',
      body: {
        name: 'USD',
        amountMinor: '100',
        currency: 'USD',
        points: '1',
        bonusPoints: '0',
        purchaseLimit: null,
        validityDays: null,
        sortOrder: 0,
      },
    });
    expect(usd).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    const created = await http.handle({
      method: 'POST',
      path: '/admin/v1/recharge-packages/drafts',
      body: {
        name: 'v1',
        amountMinor: '100',
        currency: 'CNY',
        points: '1',
        bonusPoints: '0',
        purchaseLimit: null,
        validityDays: null,
        sortOrder: 0,
      },
    });
    const first = created.body as { id: string; revision: number };
    await http.handle({
      method: 'POST',
      path: `/admin/v1/recharge-packages/${first.id}/publish`,
      body: { expectedRevision: first.revision },
    });
    const next = await http.handle({
      method: 'POST',
      path: `/admin/v1/recharge-packages/${first.id}/drafts`,
      body: { name: 'v2' },
    });
    expect(next).toMatchObject({
      status: 201,
      body: { name: 'v2', currency: 'CNY', version: 2, basePublishedVersionId: first.id },
    });
  });

  it('exposes guarded admin publication routes for system settings and feature flags', async () => {
    const publication = service();
    const http = new OperationsHttpModule({
      publication,
      adminAuthenticator: {
        authenticate: () =>
          Promise.resolve({ adminId: ADMIN, role: 'OWNER', permissions: ['operations:write'] }),
      },
    });
    const settingDraft = await http.handle({
      method: 'POST',
      path: '/admin/v1/system-settings/drafts',
      body: { key: 'site.publicConfig', publicValue: { theme: 'dark' } },
    });
    const setting = settingDraft.body as { id: string; revision: number };
    expect(
      (
        await http.handle({
          method: 'POST',
          path: `/admin/v1/system-settings/${setting.id}/publish`,
          body: { expectedRevision: setting.revision },
        })
      ).status,
    ).toBe(200);
    const flagDraft = await http.handle({
      method: 'POST',
      path: '/admin/v1/feature-flags/drafts',
      body: { flagKey: 'new-workbench', enabled: true, rules: { percent: 10 } },
    });
    const flag = flagDraft.body as { id: string; revision: number };
    expect(
      (
        await http.handle({
          method: 'POST',
          path: `/admin/v1/feature-flags/${flag.id}/publish`,
          body: { expectedRevision: flag.revision },
        })
      ).status,
    ).toBe(200);
  });

  it('rejects malformed banner windows instead of converting them to unbounded publication', async () => {
    const publication = service();
    const http = new OperationsHttpModule({
      publication,
      adminAuthenticator: {
        authenticate: () =>
          Promise.resolve({ adminId: ADMIN, role: 'ADMIN', permissions: ['operations:write'] }),
      },
    });
    expect(
      await http.handle({
        method: 'POST',
        path: '/admin/v1/banner-placements',
        body: {
          contentVersionId: '01990f24-2ba2-7000-8000-000000000099',
          slot: 'HOME_HERO',
          sortOrder: 0,
          expectedRevision: 0,
          activeFrom: 'not-a-date',
        },
      }),
    ).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
  });
});
