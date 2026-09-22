import { createUuidV7Generator, isUuidV7 } from '../domain/uuid-v7.js';

export type PublicationStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';
export type ContentKind = 'BANNER' | 'ANNOUNCEMENT' | 'HELP' | 'CASE_STUDY' | 'LEGAL';

export class PublicationError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'PublicationError';
    this.code = code;
  }
}

export interface RechargePackageVersion {
  id: string;
  packageId: string;
  version: number;
  revision: number;
  status: PublicationStatus;
  basePublishedVersionId: string | null;
  name: string;
  amountMinor: bigint;
  currency: string;
  points: bigint;
  bonusPoints: bigint;
  purchaseLimit: number | null;
  validityDays: number | null;
  sortOrder: number;
  activeFrom: Date | null;
  activeUntil: Date | null;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
  retiredAt: Date | null;
}

export interface RechargePackagePurchaseSnapshot {
  purchaseId: string;
  packageVersionId: string;
  buyerId: string;
  name: string;
  amountMinor: bigint;
  currency: string;
  points: bigint;
  bonusPoints: bigint;
  purchaseLimit: number | null;
  validityDays: number | null;
  capturedAt: Date;
}

export interface ContentEntry {
  id: string;
  kind: ContentKind;
  key: string;
  createdBy: string;
  createdAt: Date;
}

export interface ContentVersion {
  id: string;
  entryId: string;
  version: number;
  revision: number;
  status: PublicationStatus;
  basePublishedVersionId: string | null;
  title: string;
  summary: string;
  bodyHtml: string;
  sortOrder: number;
  activeFrom: Date | null;
  activeUntil: Date | null;
  helpCategoryId: string | null;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
  retiredAt: Date | null;
}

export interface BannerPlacement {
  id: string;
  contentVersionId: string;
  slot: string;
  sortOrder: number;
  activeFrom: Date | null;
  activeUntil: Date | null;
  createdBy: string;
  createdAt: Date;
}

export interface HelpCategory {
  id: string;
  key: string;
  name: string;
  sortOrder: number;
  active: boolean;
  createdBy: string;
  createdAt: Date;
}

export interface PublicSystemSettingVersion {
  id: string;
  settingKey: string;
  version: number;
  revision: number;
  status: PublicationStatus;
  basePublishedVersionId: string | null;
  publicValue: unknown;
  kmsSecretReferenceId: string | null;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
  retiredAt: Date | null;
}

export interface FeatureFlagVersion {
  id: string;
  flagKey: string;
  version: number;
  revision: number;
  status: PublicationStatus;
  basePublishedVersionId: string | null;
  enabled: boolean;
  rules: unknown;
  createdBy: string;
  createdAt: Date;
  publishedAt: Date | null;
  retiredAt: Date | null;
}

export interface OperationsOutboxEvent {
  id: string;
  type: string;
  version: number;
  occurredAt: string;
  traceId: string;
  correlationId: string;
  causationId?: string;
  producer: string;
  data: unknown;
  status: 'PENDING' | 'FAILED' | 'PUBLISHED';
  attempts: number;
  createdAt: Date;
}

export interface OperationRequestContext {
  traceId: string;
  correlationId: string;
  causationId?: string;
}

export interface PublicationState {
  packages: Map<string, RechargePackageVersion>;
  purchases: Map<string, RechargePackagePurchaseSnapshot>;
  entries: Map<string, ContentEntry>;
  content: Map<string, ContentVersion>;
  placements: Map<string, BannerPlacement>;
  slotRevisions: Map<string, number>;
  categories: Map<string, HelpCategory>;
  settings: Map<string, PublicSystemSettingVersion>;
  flags: Map<string, FeatureFlagVersion>;
  outbox: OperationsOutboxEvent[];
}

export interface PublicationRepository {
  transact<T>(
    scope: PublicationScope,
    work: (state: PublicationState) => T | Promise<T>,
  ): Promise<T>;
  snapshot(scope: PublicationScope): Promise<PublicationState>;
}

export type PublicationScope =
  | { kind: 'all' }
  | { kind: 'package'; versionId?: string; purchaseId?: string; publicAt?: Date }
  | {
      kind: 'content';
      versionId?: string;
      entryId?: string;
      entryKind?: ContentKind;
      entryKey?: string;
      categoryId?: string | null;
      categoryKey?: string;
      slot?: string;
      publicKind?: 'ANNOUNCEMENT' | 'HELP';
      publicAt?: Date;
    }
  | { kind: 'setting'; versionId?: string; settingKey?: string }
  | { kind: 'flag'; versionId?: string; flagKey?: string };

/** Deterministic adapter for domain tests and local development. Production uses PrismaPublicationRepository. */
export class InMemoryPublicationRepository implements PublicationRepository {
  #state: PublicationState = emptyState();
  #failOutbox = false;
  #tail: Promise<void> = Promise.resolve();

  async transact<T>(
    scope: PublicationScope,
    work: (state: PublicationState) => T | Promise<T>,
  ): Promise<T> {
    void scope;
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const next = cloneState(this.#state);
    try {
      const result = await work(next);
      if (this.#failOutbox && next.outbox.length > this.#state.outbox.length) {
        this.#failOutbox = false;
        throw new Error('OUTBOX_WRITE_FAILED');
      }
      this.#state = next;
      return structuredClone(result);
    } catch (error) {
      this.#failOutbox = false;
      throw error;
    } finally {
      release();
    }
  }

  snapshot(scope: PublicationScope): Promise<PublicationState> {
    void scope;
    return Promise.resolve(cloneState(this.#state));
  }
  failNextOutboxWrite(): void {
    this.#failOutbox = true;
  }
  outboxEvents(): OperationsOutboxEvent[] {
    return structuredClone(this.#state.outbox);
  }
}

export class PublicationService {
  readonly #repository: PublicationRepository;
  readonly #now: () => Date;
  readonly #id: () => string;
  readonly #trustedIframeOrigins: readonly string[];

  constructor(input: {
    repository: PublicationRepository;
    now?: () => Date;
    id?: () => string;
    trustedIframeOrigins?: readonly string[];
  }) {
    this.#repository = input.repository;
    this.#now = input.now ?? (() => new Date());
    this.#id = input.id ?? createUuidV7Generator();
    this.#trustedIframeOrigins = input.trustedIframeOrigins ?? [];
  }

  createPackageDraft(input: PackageDraftInput, actorId: string): Promise<RechargePackageVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    validatePackage(input);
    return this.#repository.transact({ kind: 'package' }, (state) => {
      const now = this.#now();
      const id = this.#id();
      const row: RechargePackageVersion = {
        id,
        packageId: id,
        version: 1,
        revision: 0,
        status: 'DRAFT',
        basePublishedVersionId: null,
        ...input,
        activeFrom: input.activeFrom ?? null,
        activeUntil: input.activeUntil ?? null,
        createdBy: actorId,
        createdAt: now,
        publishedAt: null,
        retiredAt: null,
      };
      state.packages.set(id, row);
      return row;
    });
  }

  createPackageDraftFrom(
    versionId: string,
    patch: Partial<PackageDraftInput>,
    actorId: string,
  ): Promise<RechargePackageVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'package', versionId }, (state) => {
      const source = required(state.packages.get(versionId), 'VERSION_NOT_FOUND');
      if (source.status === 'DRAFT') throw new PublicationError('SOURCE_NOT_PUBLISHED');
      const values: PackageDraftInput = {
        name: patch.name ?? source.name,
        amountMinor: patch.amountMinor ?? source.amountMinor,
        currency: patch.currency ?? source.currency,
        points: patch.points ?? source.points,
        bonusPoints: patch.bonusPoints ?? source.bonusPoints,
        purchaseLimit:
          patch.purchaseLimit === undefined ? source.purchaseLimit : patch.purchaseLimit,
        validityDays: patch.validityDays === undefined ? source.validityDays : patch.validityDays,
        sortOrder: patch.sortOrder ?? source.sortOrder,
        activeFrom: patch.activeFrom === undefined ? source.activeFrom : patch.activeFrom,
        activeUntil: patch.activeUntil === undefined ? source.activeUntil : patch.activeUntil,
      };
      validatePackage(values);
      const row: RechargePackageVersion = {
        id: this.#id(),
        packageId: source.packageId,
        version: maxPackageVersion(state, source.packageId) + 1,
        revision: 0,
        status: 'DRAFT',
        basePublishedVersionId: currentPublishedId(
          state.packages.values(),
          (row) => row.packageId === source.packageId,
        ),
        ...values,
        activeFrom: values.activeFrom ?? null,
        activeUntil: values.activeUntil ?? null,
        createdBy: actorId,
        createdAt: this.#now(),
        publishedAt: null,
        retiredAt: null,
      };
      state.packages.set(row.id, row);
      return row;
    });
  }

  updatePackageDraft(
    id: string,
    expectedRevision: number,
    patch: Partial<PackageDraftInput>,
    actorId: string,
  ): Promise<RechargePackageVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'package', versionId: id }, (state) => {
      const current = required(state.packages.get(id), 'VERSION_NOT_FOUND');
      guardDraft(current, expectedRevision);
      const updated = { ...current, ...defined(patch), revision: current.revision + 1 };
      validatePackage(updated);
      state.packages.set(id, updated);
      return updated;
    });
  }

  publishPackage(
    id: string,
    expectedRevision: number,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<RechargePackageVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'package', versionId: id }, (state) => {
      const current = required(state.packages.get(id), 'VERSION_NOT_FOUND');
      guardDraft(current, expectedRevision);
      guardPublicationBase(
        current.basePublishedVersionId,
        currentPublishedId(state.packages.values(), (row) => row.packageId === current.packageId),
      );
      const now = this.#now();
      retireCurrentPackage(state, current.packageId, now, current.id);
      const published = {
        ...current,
        status: 'PUBLISHED' as const,
        revision: current.revision + 1,
        publishedAt: now,
      };
      state.packages.set(id, published);
      addEvent(
        state,
        this.#id(),
        'operations.package.published.v1',
        {
          packageVersionId: id,
          packageId: current.packageId,
          version: current.version,
          actorId,
        },
        now,
        context,
      );
      return published;
    });
  }

  retirePackage(
    id: string,
    expectedRevision: number,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<RechargePackageVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'package', versionId: id }, (state) => {
      const current = required(state.packages.get(id), 'VERSION_NOT_FOUND');
      if (current.status !== 'PUBLISHED') throw new PublicationError('VERSION_NOT_PUBLISHED');
      if (current.revision !== expectedRevision) throw new PublicationError('VERSION_CONFLICT');
      const now = this.#now();
      const retired = {
        ...current,
        status: 'RETIRED' as const,
        revision: current.revision + 1,
        retiredAt: now,
      };
      state.packages.set(id, retired);
      addEvent(
        state,
        this.#id(),
        'operations.package.retired.v1',
        { packageVersionId: id, actorId },
        now,
        context,
      );
      return retired;
    });
  }

  async getPackageVersion(id: string): Promise<RechargePackageVersion> {
    return required(
      (await this.#repository.snapshot({ kind: 'package', versionId: id })).packages.get(id),
      'VERSION_NOT_FOUND',
    );
  }

  async capturePackagePurchase(
    purchaseId: string,
    versionId: string,
    buyerId: string,
  ): Promise<RechargePackagePurchaseSnapshot> {
    if (!isUuidV7(purchaseId)) throw new PublicationError('INVALID_PURCHASE_ID');
    if (!isUuidV7(buyerId)) throw new PublicationError('INVALID_BUYER_ID');
    try {
      return await this.#repository.transact(
        { kind: 'package', versionId, purchaseId },
        (state) => {
          const existing = state.purchases.get(purchaseId);
          if (existing !== undefined) {
            if (existing.packageVersionId !== versionId || existing.buyerId !== buyerId)
              throw new PublicationError('PURCHASE_IDEMPOTENCY_CONFLICT');
            return existing;
          }
          const version = required(state.packages.get(versionId), 'VERSION_NOT_FOUND');
          if (version.status !== 'PUBLISHED' || !activeAt(version, this.#now()))
            throw new PublicationError('PACKAGE_NOT_ACTIVE');
          const snapshot: RechargePackagePurchaseSnapshot = {
            purchaseId,
            packageVersionId: version.id,
            buyerId,
            name: version.name,
            amountMinor: version.amountMinor,
            currency: version.currency,
            points: version.points,
            bonusPoints: version.bonusPoints,
            purchaseLimit: version.purchaseLimit,
            validityDays: version.validityDays,
            capturedAt: this.#now(),
          };
          state.purchases.set(purchaseId, snapshot);
          return snapshot;
        },
      );
    } catch (error) {
      if (!(error instanceof PublicationError) || error.code !== 'VERSION_CONFLICT') throw error;
      const existing = (
        await this.#repository.snapshot({ kind: 'package', purchaseId })
      ).purchases.get(purchaseId);
      if (existing === undefined) throw error;
      if (existing.packageVersionId !== versionId || existing.buyerId !== buyerId)
        throw new PublicationError('PURCHASE_IDEMPOTENCY_CONFLICT');
      return existing;
    }
  }

  async getPackagePurchase(purchaseId: string): Promise<RechargePackagePurchaseSnapshot> {
    return required(
      (await this.#repository.snapshot({ kind: 'package', purchaseId })).purchases.get(purchaseId),
      'PURCHASE_NOT_FOUND',
    );
  }

  async listActivePackages(
    at = this.#now(),
  ): Promise<Array<RechargePackageVersion & { active: true }>> {
    return [
      ...(await this.#repository.snapshot({ kind: 'package', publicAt: at })).packages.values(),
    ]
      .filter((row) => row.status === 'PUBLISHED' && activeAt(row, at))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.version - b.version)
      .map((row) => ({ ...row, active: true as const }));
  }

  createContentEntry(
    input: { kind: ContentKind; key: string },
    actorId: string,
  ): Promise<ContentEntry> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    if (!/^[a-z0-9][a-z0-9-]{1,127}$/.test(input.key))
      throw new PublicationError('INVALID_CONTENT_KEY');
    return this.#repository.transact(
      { kind: 'content', entryKind: input.kind, entryKey: input.key },
      (state) => {
        if (
          [...state.entries.values()].some(
            (row) => row.kind === input.kind && row.key === input.key,
          )
        )
          throw new PublicationError('CONTENT_KEY_EXISTS');
        const row: ContentEntry = {
          id: this.#id(),
          ...input,
          createdBy: actorId,
          createdAt: this.#now(),
        };
        state.entries.set(row.id, row);
        return row;
      },
    );
  }

  async createContentDraft(
    entryId: string,
    input: ContentDraftInput,
    actorId: string,
  ): Promise<ContentVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    const { sanitizeRichText } = await import('../domain/rich-text.js');
    const bodyHtml = sanitizeRichText(input.bodyHtml, {
      trustedIframeOrigins: this.#trustedIframeOrigins,
    });
    return this.#repository.transact(
      { kind: 'content', entryId, categoryId: input.helpCategoryId ?? null },
      (state) => {
        validateContent(input);
        const entry = required(state.entries.get(entryId), 'CONTENT_ENTRY_NOT_FOUND');
        validateContentCategory(state, entry, input.helpCategoryId ?? null);
        const row: ContentVersion = {
          id: this.#id(),
          entryId,
          version: maxContentVersion(state, entryId) + 1,
          revision: 0,
          status: 'DRAFT',
          basePublishedVersionId: currentPublishedId(
            state.content.values(),
            (row) => row.entryId === entryId,
          ),
          ...input,
          bodyHtml,
          activeFrom: input.activeFrom ?? null,
          activeUntil: input.activeUntil ?? null,
          helpCategoryId: input.helpCategoryId ?? null,
          createdBy: actorId,
          createdAt: this.#now(),
          publishedAt: null,
          retiredAt: null,
        };
        state.content.set(row.id, row);
        return row;
      },
    );
  }

  async updateContentDraft(
    id: string,
    expectedRevision: number,
    patch: Partial<ContentDraftInput>,
    actorId: string,
  ): Promise<ContentVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    let sanitized: string | undefined;
    if (patch.bodyHtml !== undefined) {
      const { sanitizeRichText } = await import('../domain/rich-text.js');
      sanitized = sanitizeRichText(patch.bodyHtml, {
        trustedIframeOrigins: this.#trustedIframeOrigins,
      });
    }
    return this.#repository.transact(
      {
        kind: 'content',
        versionId: id,
        ...(patch.helpCategoryId === undefined ? {} : { categoryId: patch.helpCategoryId }),
      },
      (draftState) => {
        const latest = required(draftState.content.get(id), 'VERSION_NOT_FOUND');
        guardDraft(latest, expectedRevision);
        const updated = {
          ...latest,
          ...defined(patch),
          ...(sanitized === undefined ? {} : { bodyHtml: sanitized }),
          revision: latest.revision + 1,
        };
        validateContent(updated);
        validateContentCategory(
          draftState,
          required(draftState.entries.get(latest.entryId), 'CONTENT_ENTRY_NOT_FOUND'),
          updated.helpCategoryId,
        );
        draftState.content.set(id, updated);
        return updated;
      },
    );
  }

  publishContent(
    id: string,
    expectedRevision: number,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<ContentVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'content', versionId: id }, (state) => {
      const current = required(state.content.get(id), 'VERSION_NOT_FOUND');
      guardDraft(current, expectedRevision);
      guardPublicationBase(
        current.basePublishedVersionId,
        currentPublishedId(state.content.values(), (row) => row.entryId === current.entryId),
      );
      validateContentCategory(
        state,
        required(state.entries.get(current.entryId), 'CONTENT_ENTRY_NOT_FOUND'),
        current.helpCategoryId,
      );
      const now = this.#now();
      retireCurrentContent(state, current.entryId, now, current.id);
      const published = {
        ...current,
        status: 'PUBLISHED' as const,
        revision: current.revision + 1,
        publishedAt: now,
      };
      state.content.set(id, published);
      addEvent(
        state,
        this.#id(),
        'operations.content.published.v1',
        {
          contentVersionId: id,
          entryId: current.entryId,
          version: current.version,
          actorId,
        },
        now,
        context,
      );
      return published;
    });
  }

  retireContent(
    id: string,
    expectedRevision: number,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<ContentVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'content', versionId: id }, (state) => {
      const current = required(state.content.get(id), 'VERSION_NOT_FOUND');
      if (current.status !== 'PUBLISHED') throw new PublicationError('VERSION_NOT_PUBLISHED');
      if (current.revision !== expectedRevision) throw new PublicationError('VERSION_CONFLICT');
      const now = this.#now();
      const retired = {
        ...current,
        status: 'RETIRED' as const,
        revision: current.revision + 1,
        retiredAt: now,
      };
      state.content.set(id, retired);
      addEvent(
        state,
        this.#id(),
        'operations.content.retired.v1',
        { contentVersionId: id, actorId },
        now,
        context,
      );
      return retired;
    });
  }

  async rollbackContent(
    entryId: string,
    targetVersionId: string,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<ContentVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    const source = await this.getContentVersion(targetVersionId);
    if (source.entryId !== entryId || source.publishedAt === null)
      throw new PublicationError('ROLLBACK_TARGET_INVALID');
    const draft = await this.createContentDraft(
      entryId,
      {
        title: source.title,
        summary: source.summary,
        bodyHtml: source.bodyHtml,
        sortOrder: source.sortOrder,
        activeFrom: source.activeFrom,
        activeUntil: source.activeUntil,
        helpCategoryId: source.helpCategoryId,
      },
      actorId,
    );
    return this.publishContent(draft.id, draft.revision, actorId, context);
  }

  async getContentVersion(id: string): Promise<ContentVersion> {
    return required(
      (await this.#repository.snapshot({ kind: 'content', versionId: id })).content.get(id),
      'VERSION_NOT_FOUND',
    );
  }

  async listPublicContent(
    kind: 'ANNOUNCEMENT' | 'HELP',
    at = this.#now(),
  ): Promise<ContentVersion[]> {
    const state = await this.#repository.snapshot({
      kind: 'content',
      publicKind: kind,
      publicAt: at,
    });
    return [...state.content.values()]
      .filter(
        (version) =>
          state.entries.get(version.entryId)?.kind === kind &&
          version.status === 'PUBLISHED' &&
          activeAt(version, at),
      )
      .filter(
        (version) =>
          kind !== 'HELP' ||
          version.helpCategoryId === null ||
          state.categories.get(version.helpCategoryId)?.active === true,
      )
      .sort((a, b) => a.sortOrder - b.sortOrder || a.version - b.version);
  }

  placeBanner(
    input: Omit<BannerPlacement, 'id' | 'createdBy' | 'createdAt'> & { expectedRevision: number },
    actorId: string,
  ): Promise<BannerPlacement> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    validateBanner(input);
    return this.#repository.transact(
      { kind: 'content', versionId: input.contentVersionId, slot: input.slot },
      (state) => {
        const content = required(state.content.get(input.contentVersionId), 'VERSION_NOT_FOUND');
        const entry = required(state.entries.get(content.entryId), 'CONTENT_ENTRY_NOT_FOUND');
        if (content.status !== 'PUBLISHED' || entry.kind !== 'BANNER')
          throw new PublicationError('BANNER_CONTENT_NOT_ACTIVE');
        const revision = state.slotRevisions.get(input.slot) ?? 0;
        if (!Number.isSafeInteger(input.expectedRevision) || revision !== input.expectedRevision)
          throw new PublicationError('VERSION_CONFLICT');
        const placement: Omit<BannerPlacement, 'id' | 'createdBy' | 'createdAt'> = {
          contentVersionId: input.contentVersionId,
          slot: input.slot,
          sortOrder: input.sortOrder,
          activeFrom: input.activeFrom,
          activeUntil: input.activeUntil,
        };
        if (
          [...state.placements.values()].some(
            (row) => row.slot === input.slot && row.sortOrder === input.sortOrder,
          )
        )
          throw new PublicationError('BANNER_SORT_ORDER_CONFLICT');
        const row: BannerPlacement = {
          id: this.#id(),
          ...placement,
          createdBy: actorId,
          createdAt: this.#now(),
        };
        state.placements.set(row.id, row);
        state.slotRevisions.set(row.slot, revision + 1);
        return row;
      },
    );
  }

  reorderBanners(
    slot: string,
    expectedRevision: number,
    orderedIds: readonly string[],
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<{ revision: number }> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'content', slot }, (state) => {
      const revision = state.slotRevisions.get(slot) ?? 0;
      if (revision !== expectedRevision) throw new PublicationError('VERSION_CONFLICT');
      const existing = [...state.placements.values()]
        .filter((row) => row.slot === slot)
        .map((row) => row.id)
        .sort();
      if (
        new Set(orderedIds).size !== orderedIds.length ||
        [...orderedIds].sort().join('|') !== existing.join('|')
      )
        throw new PublicationError('INVALID_REORDER_SET');
      orderedIds.forEach((id, sortOrder) =>
        state.placements.set(id, {
          ...required(state.placements.get(id), 'PLACEMENT_NOT_FOUND'),
          sortOrder,
        }),
      );
      state.slotRevisions.set(slot, revision + 1);
      addEvent(
        state,
        this.#id(),
        'operations.banner.reordered.v1',
        { slot, orderedIds, actorId, revision: revision + 1 },
        this.#now(),
        context,
      );
      return { revision: revision + 1 };
    });
  }

  async listPublicBanners(
    slot: string,
    at = this.#now(),
  ): Promise<Array<{ placement: BannerPlacement; content: ContentVersion }>> {
    const state = await this.#repository.snapshot({ kind: 'content', slot, publicAt: at });
    return [...state.placements.values()]
      .filter((row) => row.slot === slot && activeAt(row, at))
      .map((placement) => ({ placement, content: state.content.get(placement.contentVersionId) }))
      .filter(
        (row): row is { placement: BannerPlacement; content: ContentVersion } =>
          row.content?.status === 'PUBLISHED' && activeAt(row.content, at),
      )
      .sort((a, b) => a.placement.sortOrder - b.placement.sortOrder);
  }

  createHelpCategory(
    input: { key: string; name: string; sortOrder: number; active?: boolean },
    actorId: string,
  ): Promise<HelpCategory> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    if (!/^[a-z0-9][a-z0-9-]{1,127}$/.test(input.key) || input.name.trim() === '')
      throw new PublicationError('INVALID_HELP_CATEGORY');
    return this.#repository.transact({ kind: 'content', categoryKey: input.key }, (state) => {
      if ([...state.categories.values()].some((row) => row.key === input.key))
        throw new PublicationError('HELP_CATEGORY_EXISTS');
      const row: HelpCategory = {
        id: this.#id(),
        ...input,
        active: input.active ?? true,
        createdBy: actorId,
        createdAt: this.#now(),
      };
      state.categories.set(row.id, row);
      return row;
    });
  }

  async createSystemSettingDraft(
    input: { key: string; publicValue?: unknown; kmsSecretReferenceId?: string },
    actorId: string,
  ): Promise<PublicSystemSettingVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    const value = validateSystemSetting(input.key, input);
    return this.#repository.transact({ kind: 'setting', settingKey: input.key }, (state) => {
      const version =
        Math.max(
          0,
          ...[...state.settings.values()]
            .filter((row) => row.settingKey === input.key)
            .map((row) => row.version),
        ) + 1;
      const row: PublicSystemSettingVersion = {
        id: this.#id(),
        settingKey: input.key,
        version,
        revision: 0,
        status: 'DRAFT',
        basePublishedVersionId: currentPublishedId(
          state.settings.values(),
          (row) => row.settingKey === input.key,
        ),
        ...value,
        createdBy: actorId,
        createdAt: this.#now(),
        publishedAt: null,
        retiredAt: null,
      };
      state.settings.set(row.id, row);
      return row;
    });
  }

  updateSystemSettingDraft(
    id: string,
    expectedRevision: number,
    patch: { publicValue?: unknown; kmsSecretReferenceId?: string },
    actorId: string,
  ): Promise<PublicSystemSettingVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'setting', versionId: id }, (state) => {
      const current = required(state.settings.get(id), 'VERSION_NOT_FOUND');
      guardDraft(current, expectedRevision);
      const value = validateSystemSetting(current.settingKey, patch);
      const updated = { ...current, ...value, revision: current.revision + 1 };
      state.settings.set(id, updated);
      return updated;
    });
  }

  publishSystemSetting(
    id: string,
    expectedRevision: number,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<PublicSystemSettingVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'setting', versionId: id }, (state) => {
      const current = required(state.settings.get(id), 'VERSION_NOT_FOUND');
      guardDraft(current, expectedRevision);
      guardPublicationBase(
        current.basePublishedVersionId,
        currentPublishedId(state.settings.values(), (row) => row.settingKey === current.settingKey),
      );
      const now = this.#now();
      for (const [versionId, row] of state.settings) {
        if (versionId !== id && row.settingKey === current.settingKey && row.status === 'PUBLISHED')
          state.settings.set(versionId, {
            ...row,
            status: 'RETIRED',
            revision: row.revision + 1,
            retiredAt: now,
          });
      }
      const published = {
        ...current,
        status: 'PUBLISHED' as const,
        revision: current.revision + 1,
        publishedAt: now,
      };
      state.settings.set(id, published);
      addEvent(
        state,
        this.#id(),
        'operations.system-setting.published.v1',
        { settingVersionId: id, settingKey: current.settingKey, actorId },
        now,
        context,
      );
      return published;
    });
  }

  retireSystemSetting(
    id: string,
    expectedRevision: number,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<PublicSystemSettingVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'setting', versionId: id }, (state) => {
      const current = required(state.settings.get(id), 'VERSION_NOT_FOUND');
      if (current.status !== 'PUBLISHED') throw new PublicationError('VERSION_NOT_PUBLISHED');
      if (current.revision !== expectedRevision) throw new PublicationError('VERSION_CONFLICT');
      const now = this.#now();
      const retired = {
        ...current,
        status: 'RETIRED' as const,
        revision: current.revision + 1,
        retiredAt: now,
      };
      state.settings.set(id, retired);
      addEvent(
        state,
        this.#id(),
        'operations.system-setting.retired.v1',
        { settingVersionId: id, actorId },
        now,
        context,
      );
      return retired;
    });
  }

  async getSystemSettingVersion(id: string): Promise<PublicSystemSettingVersion> {
    return required(
      (await this.#repository.snapshot({ kind: 'setting', versionId: id })).settings.get(id),
      'VERSION_NOT_FOUND',
    );
  }

  createFeatureFlagDraft(
    input: { flagKey: string; enabled: boolean; rules: unknown },
    actorId: string,
  ): Promise<FeatureFlagVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    validateFeatureFlag(input);
    return this.#repository.transact({ kind: 'flag', flagKey: input.flagKey }, (state) => {
      const version =
        Math.max(
          0,
          ...[...state.flags.values()]
            .filter((row) => row.flagKey === input.flagKey)
            .map((row) => row.version),
        ) + 1;
      const row: FeatureFlagVersion = {
        id: this.#id(),
        flagKey: input.flagKey,
        version,
        revision: 0,
        status: 'DRAFT',
        basePublishedVersionId: currentPublishedId(
          state.flags.values(),
          (row) => row.flagKey === input.flagKey,
        ),
        enabled: input.enabled,
        rules: structuredClone(input.rules),
        createdBy: actorId,
        createdAt: this.#now(),
        publishedAt: null,
        retiredAt: null,
      };
      state.flags.set(row.id, row);
      return row;
    });
  }

  updateFeatureFlagDraft(
    id: string,
    expectedRevision: number,
    patch: { enabled?: boolean; rules?: unknown },
    actorId: string,
  ): Promise<FeatureFlagVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'flag', versionId: id }, (state) => {
      const current = required(state.flags.get(id), 'VERSION_NOT_FOUND');
      guardDraft(current, expectedRevision);
      const updated = { ...current, ...defined(patch), revision: current.revision + 1 };
      validateFeatureFlag(updated);
      state.flags.set(id, updated);
      return updated;
    });
  }

  publishFeatureFlag(
    id: string,
    expectedRevision: number,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<FeatureFlagVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'flag', versionId: id }, (state) => {
      const current = required(state.flags.get(id), 'VERSION_NOT_FOUND');
      guardDraft(current, expectedRevision);
      guardPublicationBase(
        current.basePublishedVersionId,
        currentPublishedId(state.flags.values(), (row) => row.flagKey === current.flagKey),
      );
      const now = this.#now();
      for (const [versionId, row] of state.flags) {
        if (versionId !== id && row.flagKey === current.flagKey && row.status === 'PUBLISHED')
          state.flags.set(versionId, {
            ...row,
            status: 'RETIRED',
            revision: row.revision + 1,
            retiredAt: now,
          });
      }
      const published = {
        ...current,
        status: 'PUBLISHED' as const,
        revision: current.revision + 1,
        publishedAt: now,
      };
      state.flags.set(id, published);
      addEvent(
        state,
        this.#id(),
        'operations.feature-flag.published.v1',
        { featureFlagVersionId: id, flagKey: current.flagKey, actorId },
        now,
        context,
      );
      return published;
    });
  }

  retireFeatureFlag(
    id: string,
    expectedRevision: number,
    actorId: string,
    context = backgroundContext(this.#id),
  ): Promise<FeatureFlagVersion> {
    assertUuidV7(actorId, 'INVALID_ACTOR_ID');
    return this.#repository.transact({ kind: 'flag', versionId: id }, (state) => {
      const current = required(state.flags.get(id), 'VERSION_NOT_FOUND');
      if (current.status !== 'PUBLISHED') throw new PublicationError('VERSION_NOT_PUBLISHED');
      if (current.revision !== expectedRevision) throw new PublicationError('VERSION_CONFLICT');
      const now = this.#now();
      const retired = {
        ...current,
        status: 'RETIRED' as const,
        revision: current.revision + 1,
        retiredAt: now,
      };
      state.flags.set(id, retired);
      addEvent(
        state,
        this.#id(),
        'operations.feature-flag.retired.v1',
        { featureFlagVersionId: id, actorId },
        now,
        context,
      );
      return retired;
    });
  }

  async getFeatureFlagVersion(id: string): Promise<FeatureFlagVersion> {
    return required(
      (await this.#repository.snapshot({ kind: 'flag', versionId: id })).flags.get(id),
      'VERSION_NOT_FOUND',
    );
  }
}

export interface PackageDraftInput {
  name: string;
  amountMinor: bigint;
  currency: string;
  points: bigint;
  bonusPoints: bigint;
  purchaseLimit: number | null;
  validityDays: number | null;
  sortOrder: number;
  activeFrom?: Date | null;
  activeUntil?: Date | null;
}

export interface ContentDraftInput {
  title: string;
  summary: string;
  bodyHtml: string;
  sortOrder: number;
  activeFrom?: Date | null;
  activeUntil?: Date | null;
  helpCategoryId?: string | null;
}

function emptyState(): PublicationState {
  return {
    packages: new Map(),
    purchases: new Map(),
    entries: new Map(),
    content: new Map(),
    placements: new Map(),
    slotRevisions: new Map(),
    categories: new Map(),
    settings: new Map(),
    flags: new Map(),
    outbox: [],
  };
}
function cloneState(state: PublicationState): PublicationState {
  return structuredClone(state);
}
function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new PublicationError(code);
  return structuredClone(value);
}
function assertUuidV7(value: string, code: string): void {
  if (!isUuidV7(value)) throw new PublicationError(code);
}
function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as Partial<T>;
}
function guardDraft(row: { status: PublicationStatus; revision: number }, expected: number): void {
  if (!Number.isSafeInteger(expected) || row.revision !== expected)
    throw new PublicationError('VERSION_CONFLICT');
  if (row.status !== 'DRAFT') throw new PublicationError('PUBLISHED_VERSION_IMMUTABLE');
}
function validatePackage(input: PackageDraftInput): void {
  if (
    input.name.trim() === '' ||
    input.name.length > 120 ||
    input.amountMinor <= 0n ||
    input.points <= 0n ||
    input.bonusPoints < 0n ||
    input.currency !== 'CNY' ||
    (input.purchaseLimit !== null &&
      (!Number.isSafeInteger(input.purchaseLimit) || input.purchaseLimit <= 0)) ||
    (input.validityDays !== null &&
      (!Number.isSafeInteger(input.validityDays) || input.validityDays <= 0)) ||
    !Number.isSafeInteger(input.sortOrder) ||
    (input.activeFrom !== undefined &&
      input.activeFrom !== null &&
      input.activeUntil !== undefined &&
      input.activeUntil !== null &&
      input.activeFrom >= input.activeUntil)
  ) {
    throw new PublicationError('INVALID_PACKAGE');
  }
}
function validateContent(input: ContentDraftInput): void {
  if (
    input.title.trim() === '' ||
    input.title.length > 200 ||
    input.summary.length > 1_000 ||
    !Number.isSafeInteger(input.sortOrder) ||
    (input.activeFrom !== undefined &&
      input.activeFrom !== null &&
      input.activeUntil !== undefined &&
      input.activeUntil !== null &&
      input.activeFrom >= input.activeUntil)
  )
    throw new PublicationError('INVALID_CONTENT');
}
function validateContentCategory(
  state: PublicationState,
  entry: ContentEntry,
  categoryId: string | null,
): void {
  if (entry.kind !== 'HELP' && categoryId !== null)
    throw new PublicationError('HELP_CATEGORY_NOT_ALLOWED');
  if (categoryId === null) return;
  const category = state.categories.get(categoryId);
  if (category === undefined) throw new PublicationError('HELP_CATEGORY_NOT_FOUND');
  if (!category.active) throw new PublicationError('HELP_CATEGORY_NOT_ACTIVE');
}
function validateBanner(
  input: Pick<BannerPlacement, 'slot' | 'sortOrder' | 'activeFrom' | 'activeUntil'>,
): void {
  if (
    !/^[A-Z0-9][A-Z0-9_-]{1,63}$/.test(input.slot) ||
    !Number.isSafeInteger(input.sortOrder) ||
    (input.activeFrom !== null &&
      input.activeUntil !== null &&
      input.activeFrom >= input.activeUntil)
  )
    throw new PublicationError('INVALID_BANNER_PLACEMENT');
}
export function validateSystemSetting(
  key: string,
  input: { publicValue?: unknown; kmsSecretReferenceId?: string | null },
): Pick<PublicSystemSettingVersion, 'publicValue' | 'kmsSecretReferenceId'> {
  const hasPublic = Object.hasOwn(input, 'publicValue');
  const hasKms = input.kmsSecretReferenceId !== undefined;
  if (hasPublic === hasKms) throw new PublicationError('INVALID_SYSTEM_SETTING');
  if (hasPublic) {
    if (!PUBLIC_SYSTEM_SETTING_KEYS.has(key)) throw new PublicationError('RAW_SECRET_FORBIDDEN');
    if (
      input.publicValue === null ||
      input.publicValue === undefined ||
      !isJsonValue(input.publicValue) ||
      !validatePublicSettingValue(key, input.publicValue)
    )
      throw new PublicationError('INVALID_PUBLIC_CONFIGURATION');
    return { publicValue: structuredClone(input.publicValue), kmsSecretReferenceId: null };
  }
  if (!/^kms:\/\/[a-z0-9][a-z0-9/_-]{2,255}$/i.test(input.kmsSecretReferenceId ?? ''))
    throw new PublicationError('INVALID_KMS_REFERENCE');
  return { publicValue: null, kmsSecretReferenceId: input.kmsSecretReferenceId ?? null };
}
function validateFeatureFlag(input: { flagKey: string; enabled: boolean; rules: unknown }): void {
  if (
    !/^[a-z0-9][a-z0-9-]{1,127}$/.test(input.flagKey) ||
    typeof input.enabled !== 'boolean' ||
    !isJsonValue(input.rules)
  )
    throw new PublicationError('INVALID_FEATURE_FLAG');
}
function isJsonValue(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.every((item) => isJsonValue(item, seen));
  const record = value as Record<string, unknown>;
  return (
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(record).every((item) => isJsonValue(item, seen))
  );
}
function maxPackageVersion(state: PublicationState, packageId: string): number {
  return Math.max(
    0,
    ...[...state.packages.values()]
      .filter((row) => row.packageId === packageId)
      .map((row) => row.version),
  );
}
function maxContentVersion(state: PublicationState, entryId: string): number {
  return Math.max(
    0,
    ...[...state.content.values()]
      .filter((row) => row.entryId === entryId)
      .map((row) => row.version),
  );
}
function currentPublishedId<T extends { id: string; status: PublicationStatus }>(
  rows: Iterable<T>,
  matches: (row: T) => boolean,
): string | null {
  return [...rows].find((row) => matches(row) && row.status === 'PUBLISHED')?.id ?? null;
}
function guardPublicationBase(expected: string | null, actual: string | null): void {
  if (expected !== actual) throw new PublicationError('VERSION_CONFLICT');
}
function retireCurrentPackage(
  state: PublicationState,
  packageId: string,
  now: Date,
  exceptId: string,
): void {
  for (const [id, row] of state.packages)
    if (id !== exceptId && row.packageId === packageId && row.status === 'PUBLISHED')
      state.packages.set(id, {
        ...row,
        status: 'RETIRED',
        retiredAt: now,
        revision: row.revision + 1,
      });
}
function retireCurrentContent(
  state: PublicationState,
  entryId: string,
  now: Date,
  exceptId: string,
): void {
  for (const [id, row] of state.content)
    if (id !== exceptId && row.entryId === entryId && row.status === 'PUBLISHED')
      state.content.set(id, {
        ...row,
        status: 'RETIRED',
        retiredAt: now,
        revision: row.revision + 1,
      });
}
function activeAt(row: { activeFrom: Date | null; activeUntil: Date | null }, at: Date): boolean {
  return (
    (row.activeFrom === null || row.activeFrom <= at) &&
    (row.activeUntil === null || row.activeUntil > at)
  );
}
function addEvent(
  state: PublicationState,
  id: string,
  type: string,
  data: unknown,
  createdAt: Date,
  context: OperationRequestContext,
): void {
  if (
    !/^[a-f0-9]{32}$/.test(context.traceId) ||
    !isUuidV7(context.correlationId) ||
    (context.causationId !== undefined && !isUuidV7(context.causationId))
  )
    throw new PublicationError('INVALID_REQUEST_CONTEXT');
  state.outbox.push({
    id,
    type,
    version: 1,
    occurredAt: createdAt.toISOString(),
    traceId: context.traceId,
    correlationId: context.correlationId,
    ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    producer: 'operations-service',
    data: structuredClone(data),
    status: 'PENDING',
    attempts: 0,
    createdAt,
  });
}

const PUBLIC_SYSTEM_SETTING_KEYS = new Set([
  'site.publicConfig',
  'site.maintenanceMessage',
  'support.email',
  'cdn.publicBaseUrl',
  'legal.privacyPolicyUrl',
  'legal.termsUrl',
]);

function backgroundContext(id: () => string): OperationRequestContext {
  return {
    traceId: crypto
      .getRandomValues(new Uint8Array(16))
      .reduce((value, byte) => value + byte.toString(16).padStart(2, '0'), ''),
    correlationId: id(),
  };
}

function validatePublicSettingValue(key: string, value: unknown): boolean {
  if (containsSecret(value)) return false;
  const exact = (allowed: Record<string, (item: unknown) => boolean>): boolean => {
    if (!isPlainRecord(value) || Object.keys(value).some((field) => allowed[field] === undefined))
      return false;
    return Object.entries(value).every(([field, item]) => allowed[field]?.(item) === true);
  };
  const short =
    (max: number) =>
    (item: unknown): boolean =>
      typeof item === 'string' && item.length > 0 && item.length <= max;
  const https = (item: unknown): boolean => isStrictPublicHttpsUrl(item);
  if (key === 'site.publicConfig')
    return exact({
      siteName: short(80),
      theme: (item) => item === 'light' || item === 'dark',
      locale: (item) => item === 'zh-CN' || item === 'en-US',
      registrationEnabled: (item) => typeof item === 'boolean',
    });
  if (key === 'site.maintenanceMessage')
    return exact({ enabled: (item) => typeof item === 'boolean', message: short(500) });
  if (key === 'support.email')
    return exact({
      email: (item) =>
        typeof item === 'string' && item.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(item),
    });
  if (key === 'cdn.publicBaseUrl' || key === 'legal.privacyPolicyUrl' || key === 'legal.termsUrl')
    return exact({ url: https });
  return false;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
function containsSecret(value: unknown): boolean {
  if (typeof value === 'string')
    return (
      /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bBearer\s+[A-Za-z0-9._~-]+|\b(?:sk|pk)_[A-Za-z0-9_-]{12,}\b/i.test(
        value,
      ) || urlContainsSecret(value)
    );
  if (Array.isArray(value)) return value.some(containsSecret);
  if (!isPlainRecord(value)) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /(?:secret|token|password|private.?key|credential|api.?key)/i.test(key) ||
      containsSecret(item),
  );
}
function isStrictPublicHttpsUrl(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 500) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.search === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}
function urlContainsSecret(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '') return true;
    return [...url.searchParams].some(
      ([key, item]) =>
        /(?:secret|token|password|private.?key|credential|api.?key)/i.test(key) ||
        containsSecret(item),
    );
  } catch {
    return false;
  }
}
