import { randomBytes } from 'node:crypto';
import { PublicationError, type ContentDraftInput, type ContentKind, type OperationRequestContext, type PackageDraftInput, type PublicationService } from '../application/publication.service.js';
import { createUuidV7Generator, isUuidV7 } from '../domain/uuid-v7.js';

export type RawHeaders = Record<string, string | string[] | undefined>;
export interface OperationsHttpRequest { method: string; path: string; headers?: RawHeaders; body?: unknown; }
export interface OperationsHttpResponse { status: number; headers?: Record<string, string>; body?: unknown; }
export interface AdminPrincipal { adminId: string; role: 'OWNER' | 'ADMIN' | 'VIEWER'; permissions: readonly string[]; }
export interface AdminAuthenticator { authenticate(request: { headers: RawHeaders }): Promise<AdminPrincipal | null>; }

/** Framework-neutral controller; a Nest/Fastify adapter can mount this handler without exposing body principals. */
export class OperationsHttpModule {
  readonly #id = createUuidV7Generator();
  constructor(private readonly dependencies: { publication: PublicationService; adminAuthenticator: AdminAuthenticator }) {}

  async handle(request: OperationsHttpRequest): Promise<OperationsHttpResponse> {
    const traceId = resolveTraceId(request.headers);
    const context = resolveContext(request.headers, traceId, this.#id);
    try {
      return jsonResponse(withTrace(await this.#route(request, context), traceId));
    } catch (error) { return withTrace(mapError(error, traceId), traceId); }
  }

  async #route(request: OperationsHttpRequest, context: OperationRequestContext): Promise<OperationsHttpResponse> {
    if (request.path.startsWith('/admin/')) return this.#admin(request, context);
    if (request.method !== 'GET') return notFound(context.traceId);
    if (request.path === '/v1/recharge-packages') return { status: 200, body: (await this.dependencies.publication.listActivePackages()).map((row) => ({
      id: row.id, name: row.name, points: row.points.toString(10), bonusPoints: row.bonusPoints.toString(10), active: row.active,
    })) };
    if (request.path === '/v1/announcements') return { status: 200, body: await this.dependencies.publication.listPublicContent('ANNOUNCEMENT') };
    if (request.path === '/v1/help') return { status: 200, body: await this.dependencies.publication.listPublicContent('HELP') };
    const banners = /^\/v1\/banners\/([A-Z0-9_-]{1,64})$/.exec(request.path);
    if (banners !== null) return { status: 200, body: await this.dependencies.publication.listPublicBanners(banners[1] ?? '') };
    return notFound(context.traceId);
  }

  async #admin(request: OperationsHttpRequest, context: OperationRequestContext): Promise<OperationsHttpResponse> {
    const invalidRequest = (): OperationsHttpResponse => apiError(400, 'INVALID_REQUEST', context.traceId, false);
    const principal = await this.dependencies.adminAuthenticator.authenticate({ headers: normalizeHeaders(request.headers) });
    if (principal === null) return apiError(401, 'UNAUTHENTICATED', context.traceId, false);
    if ((principal.role !== 'OWNER' && principal.role !== 'ADMIN') || !principal.permissions.includes('operations:write')) return apiError(403, 'FORBIDDEN', context.traceId, false);
    const pathId = /^\/admin\/v1\/(?:recharge-packages|content-entries|content-versions|system-settings|feature-flags)\/([^/]+)\//i.exec(request.path)?.[1];
    if (pathId !== undefined && !isUuidV7(pathId)) return invalidRequest();

    if (request.method === 'POST' && request.path === '/admin/v1/recharge-packages/drafts') {
      const body = parsePackageDraft(request.body);
      if (body === null) return invalidRequest();
      return { status: 201, body: await this.dependencies.publication.createPackageDraft(body, principal.adminId) };
    }
    let match = /^\/admin\/v1\/recharge-packages\/([0-9a-f-]+)\/drafts$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const body = asRecord(request.body); const patch = body === null ? null : parsePackagePatch(body);
      if (patch === null) return invalidRequest();
      return { status: 201, body: await this.dependencies.publication.createPackageDraftFrom(match[1] ?? '', patch, principal.adminId) };
    }
    match = /^\/admin\/v1\/recharge-packages\/([0-9a-f-]+)\/preview$/i.exec(request.path);
    if (request.method === 'GET' && match !== null) return { status: 200, body: await this.dependencies.publication.getPackageVersion(match[1] ?? '') };
    match = /^\/admin\/v1\/recharge-packages\/([0-9a-f-]+)\/draft$/i.exec(request.path);
    if (request.method === 'PATCH' && match !== null) {
      const parsed = parseRevisionPatch(request.body, parsePackagePatch);
      if (parsed === null) return invalidRequest();
      return { status: 200, body: await this.dependencies.publication.updatePackageDraft(match[1] ?? '', parsed.expectedRevision, parsed.patch, principal.adminId) };
    }
    match = /^\/admin\/v1\/recharge-packages\/([0-9a-f-]+)\/(publish|retire)$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const revision = parseExpectedRevision(request.body);
      if (revision === null) return invalidRequest();
      const result = match[2] === 'publish'
        ? await this.dependencies.publication.publishPackage(match[1] ?? '', revision, principal.adminId, context)
        : await this.dependencies.publication.retirePackage(match[1] ?? '', revision, principal.adminId, context);
      return { status: 200, body: result };
    }
    if (request.method === 'POST' && request.path === '/admin/v1/content-entries') {
      const body = asRecord(request.body);
      if (body === null || !isContentKind(body.kind) || typeof body.key !== 'string') return invalidRequest();
      return { status: 201, body: await this.dependencies.publication.createContentEntry({ kind: body.kind, key: body.key }, principal.adminId) };
    }
    match = /^\/admin\/v1\/content-entries\/([0-9a-f-]+)\/drafts$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const body = parseContentDraft(request.body);
      if (body === null) return invalidRequest();
      return { status: 201, body: await this.dependencies.publication.createContentDraft(match[1] ?? '', body, principal.adminId) };
    }
    match = /^\/admin\/v1\/content-versions\/([0-9a-f-]+)\/preview$/i.exec(request.path);
    if (request.method === 'GET' && match !== null) return { status: 200, body: await this.dependencies.publication.getContentVersion(match[1] ?? '') };
    match = /^\/admin\/v1\/content-versions\/([0-9a-f-]+)\/draft$/i.exec(request.path);
    if (request.method === 'PATCH' && match !== null) {
      const parsed = parseRevisionPatch(request.body, parseContentPatch);
      if (parsed === null) return invalidRequest();
      return { status: 200, body: await this.dependencies.publication.updateContentDraft(match[1] ?? '', parsed.expectedRevision, parsed.patch, principal.adminId) };
    }
    match = /^\/admin\/v1\/content-versions\/([0-9a-f-]+)\/(publish|retire)$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const revision = parseExpectedRevision(request.body);
      if (revision === null) return invalidRequest();
      const result = match[2] === 'publish'
        ? await this.dependencies.publication.publishContent(match[1] ?? '', revision, principal.adminId, context)
        : await this.dependencies.publication.retireContent(match[1] ?? '', revision, principal.adminId, context);
      return { status: 200, body: result };
    }
    match = /^\/admin\/v1\/content-entries\/([0-9a-f-]+)\/rollback$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const body = asRecord(request.body);
      if (body === null || typeof body.targetVersionId !== 'string' || !isUuidV7(body.targetVersionId)) return invalidRequest();
      return { status: 200, body: await this.dependencies.publication.rollbackContent(match[1] ?? '', body.targetVersionId, principal.adminId, context) };
    }
    if (request.method === 'POST' && request.path === '/admin/v1/banner-placements') {
      const body = parseBannerPlacement(request.body);
      if (body === null) return invalidRequest();
      return { status: 201, body: await this.dependencies.publication.placeBanner(body, principal.adminId) };
    }
    match = /^\/admin\/v1\/banners\/([A-Z0-9_-]{1,64})\/reorder$/.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const body = asRecord(request.body);
      if (body === null || !isRevision(body.expectedRevision) || !Array.isArray(body.orderedPlacementIds) || !body.orderedPlacementIds.every((id) => typeof id === 'string' && isUuidV7(id))) return invalidRequest();
      return { status: 200, body: await this.dependencies.publication.reorderBanners(match[1] ?? '', body.expectedRevision, body.orderedPlacementIds, principal.adminId, context) };
    }
    if (request.method === 'POST' && request.path === '/admin/v1/system-settings/drafts') {
      const body = asRecord(request.body);
      if (body === null || typeof body.key !== 'string') return invalidRequest();
      const value = parseSystemSettingValue(body); if (value === null) return invalidRequest();
      return { status: 201, body: await this.dependencies.publication.createSystemSettingDraft({ key: body.key, ...value }, principal.adminId) };
    }
    match = /^\/admin\/v1\/system-settings\/([0-9a-f-]+)\/preview$/i.exec(request.path);
    if (request.method === 'GET' && match !== null) return { status: 200, body: await this.dependencies.publication.getSystemSettingVersion(match[1] ?? '') };
    match = /^\/admin\/v1\/system-settings\/([0-9a-f-]+)\/draft$/i.exec(request.path);
    if (request.method === 'PATCH' && match !== null) {
      const parsed = parseRevisionPatch(request.body, parseSystemSettingValue); if (parsed === null) return invalidRequest();
      return { status: 200, body: await this.dependencies.publication.updateSystemSettingDraft(match[1] ?? '', parsed.expectedRevision, parsed.patch, principal.adminId) };
    }
    match = /^\/admin\/v1\/system-settings\/([0-9a-f-]+)\/(publish|retire)$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const revision = parseExpectedRevision(request.body); if (revision === null) return invalidRequest();
      const result = match[2] === 'publish'
        ? await this.dependencies.publication.publishSystemSetting(match[1] ?? '', revision, principal.adminId, context)
        : await this.dependencies.publication.retireSystemSetting(match[1] ?? '', revision, principal.adminId, context);
      return { status: 200, body: result };
    }
    if (request.method === 'POST' && request.path === '/admin/v1/feature-flags/drafts') {
      const body = asRecord(request.body);
      if (body === null || typeof body.flagKey !== 'string' || typeof body.enabled !== 'boolean' || !Object.hasOwn(body, 'rules')) return invalidRequest();
      return { status: 201, body: await this.dependencies.publication.createFeatureFlagDraft({ flagKey: body.flagKey, enabled: body.enabled, rules: body.rules }, principal.adminId) };
    }
    match = /^\/admin\/v1\/feature-flags\/([0-9a-f-]+)\/preview$/i.exec(request.path);
    if (request.method === 'GET' && match !== null) return { status: 200, body: await this.dependencies.publication.getFeatureFlagVersion(match[1] ?? '') };
    match = /^\/admin\/v1\/feature-flags\/([0-9a-f-]+)\/draft$/i.exec(request.path);
    if (request.method === 'PATCH' && match !== null) {
      const parsed = parseRevisionPatch(request.body, parseFeatureFlagPatch); if (parsed === null) return invalidRequest();
      return { status: 200, body: await this.dependencies.publication.updateFeatureFlagDraft(match[1] ?? '', parsed.expectedRevision, parsed.patch, principal.adminId) };
    }
    match = /^\/admin\/v1\/feature-flags\/([0-9a-f-]+)\/(publish|retire)$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const revision = parseExpectedRevision(request.body); if (revision === null) return invalidRequest();
      const result = match[2] === 'publish'
        ? await this.dependencies.publication.publishFeatureFlag(match[1] ?? '', revision, principal.adminId, context)
        : await this.dependencies.publication.retireFeatureFlag(match[1] ?? '', revision, principal.adminId, context);
      return { status: 200, body: result };
    }
    return notFound(context.traceId);
  }
}

function normalizeHeaders(headers: RawHeaders | undefined): RawHeaders { return Object.fromEntries(Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])); }
function asRecord(value: unknown): Record<string, unknown> | null { return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function isRevision(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isContentKind(value: unknown): value is ContentKind { return ['BANNER', 'ANNOUNCEMENT', 'HELP', 'CASE_STUDY', 'LEGAL'].includes(String(value)); }
function parseExpectedRevision(value: unknown): number | null { const body = asRecord(value); return body !== null && isRevision(body.expectedRevision) ? body.expectedRevision : null; }
function parseBigint(value: unknown): bigint | null { if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null; try { return BigInt(value); } catch { return null; } }
function parseDate(value: unknown): Date | null | undefined { if (value === null) return null; if (value === undefined) return undefined; if (typeof value !== 'string') return undefined; const date = new Date(value); return Number.isNaN(date.valueOf()) ? undefined : date; }
function parsePackageDraft(value: unknown) {
  const body = asRecord(value); if (body === null) return null;
  const amountMinor = parseBigint(body.amountMinor); const points = parseBigint(body.points); const bonusPoints = parseBigint(body.bonusPoints);
  const activeFrom = parseDate(body.activeFrom); const activeUntil = parseDate(body.activeUntil);
  if ((body.activeFrom !== undefined && activeFrom === undefined) || (body.activeUntil !== undefined && activeUntil === undefined)) return null;
  if (typeof body.name !== 'string' || amountMinor === null || body.currency !== 'CNY' || points === null || bonusPoints === null ||
    !(body.purchaseLimit === null || (typeof body.purchaseLimit === 'number' && Number.isSafeInteger(body.purchaseLimit))) ||
    !(body.validityDays === null || (typeof body.validityDays === 'number' && Number.isSafeInteger(body.validityDays))) || !isRevision(body.sortOrder)) return null;
  return { name: body.name, amountMinor, currency: body.currency, points, bonusPoints, purchaseLimit: body.purchaseLimit, validityDays: body.validityDays, sortOrder: body.sortOrder, ...(activeFrom === undefined ? {} : { activeFrom }), ...(activeUntil === undefined ? {} : { activeUntil }) };
}
function parsePackagePatch(value: Record<string, unknown>): Partial<PackageDraftInput> | null {
  const patch: Partial<PackageDraftInput> = {};
  if (value.name !== undefined) { if (typeof value.name !== 'string') return null; patch.name = value.name; }
  for (const field of ['amountMinor', 'points', 'bonusPoints'] as const) {
    if (value[field] === undefined) continue;
    const parsed = parseBigint(value[field]); if (parsed === null) return null; patch[field] = parsed;
  }
  if (value.currency !== undefined) { if (value.currency !== 'CNY') return null; patch.currency = value.currency; }
  for (const field of ['purchaseLimit', 'validityDays'] as const) {
    const item = value[field]; if (item === undefined) continue;
    if (!(item === null || (typeof item === 'number' && Number.isSafeInteger(item)))) return null;
    patch[field] = item;
  }
  if (value.sortOrder !== undefined) { if (!isRevision(value.sortOrder)) return null; patch.sortOrder = value.sortOrder; }
  for (const field of ['activeFrom', 'activeUntil'] as const) {
    if (value[field] === undefined) continue;
    const parsed = parseDate(value[field]); if (parsed === undefined) return null; patch[field] = parsed;
  }
  return patch;
}
function parseContentDraft(value: unknown) { const body = asRecord(value); if (body === null || typeof body.title !== 'string' || typeof body.summary !== 'string' || typeof body.bodyHtml !== 'string' || !isRevision(body.sortOrder)) return null; const activeFrom = parseDate(body.activeFrom); const activeUntil = parseDate(body.activeUntil); if ((body.activeFrom !== undefined && activeFrom === undefined) || (body.activeUntil !== undefined && activeUntil === undefined) || !(body.helpCategoryId === undefined || body.helpCategoryId === null || (typeof body.helpCategoryId === 'string' && isUuidV7(body.helpCategoryId)))) return null; return { title: body.title, summary: body.summary, bodyHtml: body.bodyHtml, sortOrder: body.sortOrder, ...(activeFrom === undefined ? {} : { activeFrom }), ...(activeUntil === undefined ? {} : { activeUntil }), ...(body.helpCategoryId === undefined ? {} : { helpCategoryId: body.helpCategoryId }) }; }
function parseContentPatch(value: Record<string, unknown>): Partial<ContentDraftInput> | null {
  const patch: Partial<ContentDraftInput> = {};
  for (const field of ['title', 'summary', 'bodyHtml'] as const) {
    if (value[field] === undefined) continue; if (typeof value[field] !== 'string') return null; patch[field] = value[field];
  }
  if (value.sortOrder !== undefined) { if (!isRevision(value.sortOrder)) return null; patch.sortOrder = value.sortOrder; }
  for (const field of ['activeFrom', 'activeUntil'] as const) {
    if (value[field] === undefined) continue; const parsed = parseDate(value[field]); if (parsed === undefined) return null; patch[field] = parsed;
  }
  if (value.helpCategoryId !== undefined) {
    if (!(value.helpCategoryId === null || (typeof value.helpCategoryId === 'string' && isUuidV7(value.helpCategoryId)))) return null;
    patch.helpCategoryId = value.helpCategoryId;
  }
  return patch;
}
function parseRevisionPatch<T>(value: unknown, parse: (value: Record<string, unknown>) => T | null): { expectedRevision: number; patch: T } | null { const body = asRecord(value); if (body === null || !isRevision(body.expectedRevision)) return null; const { expectedRevision, ...rawPatch } = body; const patch = parse(rawPatch); return patch === null ? null : { expectedRevision, patch }; }
function parseBannerPlacement(value: unknown) { const body = asRecord(value); if (body === null || typeof body.contentVersionId !== 'string' || !isUuidV7(body.contentVersionId) || typeof body.slot !== 'string' || !isRevision(body.sortOrder) || !isRevision(body.expectedRevision)) return null; const activeFrom = parseDate(body.activeFrom); const activeUntil = parseDate(body.activeUntil); if ((body.activeFrom !== undefined && activeFrom === undefined) || (body.activeUntil !== undefined && activeUntil === undefined)) return null; return { contentVersionId: body.contentVersionId, slot: body.slot, sortOrder: body.sortOrder, expectedRevision: body.expectedRevision, activeFrom: activeFrom ?? null, activeUntil: activeUntil ?? null }; }
function parseSystemSettingValue(value: Record<string, unknown>): { publicValue: unknown } | { kmsSecretReferenceId: string } | null {
  const hasPublic = Object.hasOwn(value, 'publicValue'); const hasKms = Object.hasOwn(value, 'kmsSecretReferenceId');
  if (hasPublic === hasKms) return null;
  return hasPublic ? { publicValue: value.publicValue } : typeof value.kmsSecretReferenceId === 'string' ? { kmsSecretReferenceId: value.kmsSecretReferenceId } : null;
}
function parseFeatureFlagPatch(value: Record<string, unknown>): { enabled?: boolean; rules?: unknown } | null {
  const patch: { enabled?: boolean; rules?: unknown } = {};
  if (value.enabled !== undefined) { if (typeof value.enabled !== 'boolean') return null; patch.enabled = value.enabled; }
  if (Object.hasOwn(value, 'rules')) patch.rules = value.rules;
  return Object.keys(patch).length === 0 ? null : patch;
}
function notFound(traceId: string): OperationsHttpResponse { return apiError(404, 'ROUTE_NOT_FOUND', traceId, false); }
function mapError(error: unknown, traceId: string): OperationsHttpResponse {
  if (!(error instanceof PublicationError)) return apiError(500, 'INTERNAL_ERROR', traceId, true);
  if (error.code.includes('NOT_FOUND')) return apiError(404, error.code, traceId, false);
  if (error.code === 'VERSION_CONFLICT') return apiError(409, error.code, traceId, true);
  return apiError(422, error.code, traceId, false);
}

function apiError(status: number, code: string, traceId: string, retryable: boolean, details?: unknown): OperationsHttpResponse {
  return { status, body: { code, message: code, traceId, retryable, ...(details === undefined ? {} : { details }) } };
}
function resolveTraceId(headers: RawHeaders | undefined): string {
  const incoming = normalizeHeaders(headers)['x-trace-id'];
  return typeof incoming === 'string' && /^[a-f0-9]{32}$/.test(incoming) ? incoming : randomBytes(16).toString('hex');
}
function resolveContext(headers: RawHeaders | undefined, traceId: string, id: () => string): OperationRequestContext {
  const normalized = normalizeHeaders(headers); const incoming = normalized['x-correlation-id']; const correlationId = typeof incoming === 'string' && isUuidV7(incoming) ? incoming : id();
  const causation = normalized['x-causation-id'];
  return { traceId, correlationId, ...(typeof causation === 'string' && isUuidV7(causation) ? { causationId: causation } : {}) };
}
function withTrace(response: OperationsHttpResponse, traceId: string): OperationsHttpResponse { return { ...response, headers: { ...response.headers, 'x-trace-id': traceId } }; }

function jsonResponse(response: OperationsHttpResponse): OperationsHttpResponse {
  return response.body === undefined ? response : { ...response, body: jsonValue(response.body) };
}

function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  return value;
}
