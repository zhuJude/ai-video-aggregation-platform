import { randomBytes } from 'node:crypto';
import {
  PublicationError,
  type ContentDraftInput,
  type ContentKind,
  type OperationRequestContext,
  type PackageDraftInput,
  type PublicationService,
} from '../application/publication.service.js';
import {
  TicketError,
  type AttachmentInput,
  type Feedback,
  type FeedbackKind,
  type TicketMessage,
  type TicketService,
} from '../application/ticket.service.js';
import { createUuidV7Generator, isUuidV7 } from '../domain/uuid-v7.js';

export type RawHeaders = Record<string, string | string[] | undefined>;
export interface OperationsHttpRequest {
  method: string;
  path: string;
  headers?: RawHeaders;
  query?: Record<string, unknown>;
  body?: unknown;
}
export interface OperationsHttpResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
}
export interface AdminPrincipal {
  adminId: string;
  role: 'OWNER' | 'ADMIN' | 'VIEWER';
  permissions: readonly string[];
}
export interface AdminAuthenticator {
  authenticate(request: { headers: RawHeaders }): Promise<AdminPrincipal | null>;
}
export interface UserPrincipal {
  userId: string;
}
export interface UserAuthenticator {
  authenticate(request: { headers: RawHeaders }): Promise<UserPrincipal | null>;
}

/** Framework-neutral controller; a Nest/Fastify adapter can mount this handler without exposing body principals. */
export class OperationsHttpModule {
  readonly #id = createUuidV7Generator();
  constructor(
    private readonly dependencies: {
      publication: PublicationService;
      adminAuthenticator: AdminAuthenticator;
      ticket?: TicketService;
      userAuthenticator?: UserAuthenticator;
    },
  ) {}

  async handle(request: OperationsHttpRequest): Promise<OperationsHttpResponse> {
    const traceId = resolveTraceId(request.headers);
    const context = resolveContext(request.headers, traceId, this.#id);
    try {
      return jsonResponse(withTrace(await this.#route(request, context), traceId));
    } catch (error) {
      return withTrace(mapError(error, traceId), traceId);
    }
  }

  async #route(
    request: OperationsHttpRequest,
    context: OperationRequestContext,
  ): Promise<OperationsHttpResponse> {
    if (request.path.startsWith('/admin/')) return this.#admin(request, context);
    if (
      request.path === '/v1/tickets' ||
      request.path.startsWith('/v1/tickets/') ||
      request.path === '/v1/feedback' ||
      request.path.startsWith('/v1/feedback/')
    )
      return this.#userSupport(request, context);
    if (request.method !== 'GET') return notFound(context.traceId);
    if (request.path === '/v1/recharge-packages')
      return {
        status: 200,
        body: (await this.dependencies.publication.listActivePackages()).map((row) => ({
          id: row.id,
          name: row.name,
          points: row.points.toString(10),
          bonusPoints: row.bonusPoints.toString(10),
          active: row.active,
        })),
      };
    if (request.path === '/v1/announcements')
      return {
        status: 200,
        body: await this.dependencies.publication.listPublicContent('ANNOUNCEMENT'),
      };
    if (request.path === '/v1/help')
      return { status: 200, body: await this.dependencies.publication.listPublicContent('HELP') };
    const banners = /^\/v1\/banners\/([A-Z0-9_-]{1,64})$/.exec(request.path);
    if (banners !== null)
      return {
        status: 200,
        body: await this.dependencies.publication.listPublicBanners(banners[1] ?? ''),
      };
    return notFound(context.traceId);
  }

  async #userSupport(
    request: OperationsHttpRequest,
    context: OperationRequestContext,
  ): Promise<OperationsHttpResponse> {
    const service = this.dependencies.ticket;
    const authenticator = this.dependencies.userAuthenticator;
    if (service === undefined || authenticator === undefined) return notFound(context.traceId);
    const principal = await authenticator.authenticate({
      headers: normalizeHeaders(request.headers),
    });
    if (principal === null) return apiError(401, 'UNAUTHENTICATED', context.traceId, false);
    const invalid = (): OperationsHttpResponse =>
      apiError(400, 'INVALID_REQUEST', context.traceId, false);

    if (request.method === 'POST' && request.path === '/v1/tickets') {
      const body = parseTicketCreate(request.body);
      if (body === null) return invalid();
      return { status: 201, body: await service.create(body, principal.userId, context) };
    }
    if (request.method === 'GET' && request.path === '/v1/tickets') {
      const page = parsePage(request.query);
      if (page === null) return invalid();
      return { status: 200, body: await service.list(principal.userId, page) };
    }
    let match = /^\/v1\/tickets\/([0-9a-f-]+)$/i.exec(request.path);
    if (request.method === 'GET' && match !== null) {
      if (!isUuidV7(match[1] ?? '')) return invalid();
      return {
        status: 200,
        body: userTicketView(await service.get(match[1] ?? '', principal.userId)),
      };
    }
    match = /^\/v1\/tickets\/([0-9a-f-]+)\/messages$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      if (!isUuidV7(match[1] ?? '')) return invalid();
      const body = parseTicketMessage(request.body);
      const key = singleHeader(request.headers, 'idempotency-key');
      if (body === null || key === null) return invalid();
      return {
        status: 201,
        body: ticketMessageResult(
          await service.addMessage(match[1] ?? '', body, principal.userId, key, context),
        ),
      };
    }
    match = /^\/v1\/tickets\/([0-9a-f-]+)\/reopen$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      if (!isUuidV7(match[1] ?? '')) return invalid();
      const revision = parseExpectedRevision(request.body);
      if (revision === null) return invalid();
      return {
        status: 200,
        body: await service.reopen(match[1] ?? '', revision, principal.userId, context),
      };
    }
    if (request.method === 'POST' && request.path === '/v1/feedback') {
      const body = parseFeedback(request.body);
      if (body === null) return invalid();
      return {
        status: 201,
        body: publicFeedback(await service.createFeedback(body, principal.userId, context)),
      };
    }
    if (request.method === 'GET' && request.path === '/v1/feedback') {
      const page = parsePage(request.query);
      if (page === null) return invalid();
      const result = await service.listFeedback(principal.userId, page);
      return { status: 200, body: { ...result, items: result.items.map(publicFeedback) } };
    }
    match = /^\/v1\/feedback\/([0-9a-f-]+)$/i.exec(request.path);
    if (request.method === 'GET' && match !== null) {
      if (!isUuidV7(match[1] ?? '')) return invalid();
      return {
        status: 200,
        body: publicFeedback(await service.getFeedback(match[1] ?? '', principal.userId)),
      };
    }
    return notFound(context.traceId);
  }

  async #admin(
    request: OperationsHttpRequest,
    context: OperationRequestContext,
  ): Promise<OperationsHttpResponse> {
    const invalidRequest = (): OperationsHttpResponse =>
      apiError(400, 'INVALID_REQUEST', context.traceId, false);
    const principal = await this.dependencies.adminAuthenticator.authenticate({
      headers: normalizeHeaders(request.headers),
    });
    if (principal === null) return apiError(401, 'UNAUTHENTICATED', context.traceId, false);
    if (request.path === '/admin/v1/feedback' || request.path.startsWith('/admin/v1/tickets/'))
      return this.#adminSupport(request, principal, context);
    if (
      (principal.role !== 'OWNER' && principal.role !== 'ADMIN') ||
      !principal.permissions.includes('operations:write')
    )
      return apiError(403, 'FORBIDDEN', context.traceId, false);
    const pathId =
      /^\/admin\/v1\/(?:recharge-packages|content-entries|content-versions|system-settings|feature-flags)\/([^/]+)\//i.exec(
        request.path,
      )?.[1];
    if (pathId !== undefined && !isUuidV7(pathId)) return invalidRequest();

    if (request.method === 'POST' && request.path === '/admin/v1/recharge-packages/drafts') {
      const body = parsePackageDraft(request.body);
      if (body === null) return invalidRequest();
      return {
        status: 201,
        body: await this.dependencies.publication.createPackageDraft(body, principal.adminId),
      };
    }
    let match = /^\/admin\/v1\/recharge-packages\/([0-9a-f-]+)\/drafts$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const body = asRecord(request.body);
      const patch = body === null ? null : parsePackagePatch(body);
      if (patch === null) return invalidRequest();
      return {
        status: 201,
        body: await this.dependencies.publication.createPackageDraftFrom(
          match[1] ?? '',
          patch,
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/recharge-packages\/([0-9a-f-]+)\/preview$/i.exec(request.path);
    if (request.method === 'GET' && match !== null)
      return {
        status: 200,
        body: await this.dependencies.publication.getPackageVersion(match[1] ?? ''),
      };
    match = /^\/admin\/v1\/recharge-packages\/([0-9a-f-]+)\/draft$/i.exec(request.path);
    if (request.method === 'PATCH' && match !== null) {
      const parsed = parseRevisionPatch(request.body, parsePackagePatch);
      if (parsed === null) return invalidRequest();
      return {
        status: 200,
        body: await this.dependencies.publication.updatePackageDraft(
          match[1] ?? '',
          parsed.expectedRevision,
          parsed.patch,
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/recharge-packages\/([0-9a-f-]+)\/(publish|retire)$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const revision = parseExpectedRevision(request.body);
      if (revision === null) return invalidRequest();
      const result =
        match[2] === 'publish'
          ? await this.dependencies.publication.publishPackage(
              match[1] ?? '',
              revision,
              principal.adminId,
              context,
            )
          : await this.dependencies.publication.retirePackage(
              match[1] ?? '',
              revision,
              principal.adminId,
              context,
            );
      return { status: 200, body: result };
    }
    if (request.method === 'POST' && request.path === '/admin/v1/content-entries') {
      const body = asRecord(request.body);
      if (body === null || !isContentKind(body.kind) || typeof body.key !== 'string')
        return invalidRequest();
      return {
        status: 201,
        body: await this.dependencies.publication.createContentEntry(
          { kind: body.kind, key: body.key },
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/content-entries\/([0-9a-f-]+)\/drafts$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const body = parseContentDraft(request.body);
      if (body === null) return invalidRequest();
      return {
        status: 201,
        body: await this.dependencies.publication.createContentDraft(
          match[1] ?? '',
          body,
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/content-versions\/([0-9a-f-]+)\/preview$/i.exec(request.path);
    if (request.method === 'GET' && match !== null)
      return {
        status: 200,
        body: await this.dependencies.publication.getContentVersion(match[1] ?? ''),
      };
    match = /^\/admin\/v1\/content-versions\/([0-9a-f-]+)\/draft$/i.exec(request.path);
    if (request.method === 'PATCH' && match !== null) {
      const parsed = parseRevisionPatch(request.body, parseContentPatch);
      if (parsed === null) return invalidRequest();
      return {
        status: 200,
        body: await this.dependencies.publication.updateContentDraft(
          match[1] ?? '',
          parsed.expectedRevision,
          parsed.patch,
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/content-versions\/([0-9a-f-]+)\/(publish|retire)$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const revision = parseExpectedRevision(request.body);
      if (revision === null) return invalidRequest();
      const result =
        match[2] === 'publish'
          ? await this.dependencies.publication.publishContent(
              match[1] ?? '',
              revision,
              principal.adminId,
              context,
            )
          : await this.dependencies.publication.retireContent(
              match[1] ?? '',
              revision,
              principal.adminId,
              context,
            );
      return { status: 200, body: result };
    }
    match = /^\/admin\/v1\/content-entries\/([0-9a-f-]+)\/rollback$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const body = asRecord(request.body);
      if (
        body === null ||
        typeof body.targetVersionId !== 'string' ||
        !isUuidV7(body.targetVersionId)
      )
        return invalidRequest();
      return {
        status: 200,
        body: await this.dependencies.publication.rollbackContent(
          match[1] ?? '',
          body.targetVersionId,
          principal.adminId,
          context,
        ),
      };
    }
    if (request.method === 'POST' && request.path === '/admin/v1/banner-placements') {
      const body = parseBannerPlacement(request.body);
      if (body === null) return invalidRequest();
      return {
        status: 201,
        body: await this.dependencies.publication.placeBanner(body, principal.adminId),
      };
    }
    match = /^\/admin\/v1\/banners\/([A-Z0-9_-]{1,64})\/reorder$/.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const body = asRecord(request.body);
      if (
        body === null ||
        !isRevision(body.expectedRevision) ||
        !Array.isArray(body.orderedPlacementIds) ||
        !body.orderedPlacementIds.every((id) => typeof id === 'string' && isUuidV7(id))
      )
        return invalidRequest();
      return {
        status: 200,
        body: await this.dependencies.publication.reorderBanners(
          match[1] ?? '',
          body.expectedRevision,
          body.orderedPlacementIds,
          principal.adminId,
          context,
        ),
      };
    }
    if (request.method === 'POST' && request.path === '/admin/v1/system-settings/drafts') {
      const body = asRecord(request.body);
      if (body === null || typeof body.key !== 'string') return invalidRequest();
      const value = parseSystemSettingValue(body);
      if (value === null) return invalidRequest();
      return {
        status: 201,
        body: await this.dependencies.publication.createSystemSettingDraft(
          { key: body.key, ...value },
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/system-settings\/([0-9a-f-]+)\/preview$/i.exec(request.path);
    if (request.method === 'GET' && match !== null)
      return {
        status: 200,
        body: await this.dependencies.publication.getSystemSettingVersion(match[1] ?? ''),
      };
    match = /^\/admin\/v1\/system-settings\/([0-9a-f-]+)\/draft$/i.exec(request.path);
    if (request.method === 'PATCH' && match !== null) {
      const parsed = parseRevisionPatch(request.body, parseSystemSettingValue);
      if (parsed === null) return invalidRequest();
      return {
        status: 200,
        body: await this.dependencies.publication.updateSystemSettingDraft(
          match[1] ?? '',
          parsed.expectedRevision,
          parsed.patch,
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/system-settings\/([0-9a-f-]+)\/(publish|retire)$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const revision = parseExpectedRevision(request.body);
      if (revision === null) return invalidRequest();
      const result =
        match[2] === 'publish'
          ? await this.dependencies.publication.publishSystemSetting(
              match[1] ?? '',
              revision,
              principal.adminId,
              context,
            )
          : await this.dependencies.publication.retireSystemSetting(
              match[1] ?? '',
              revision,
              principal.adminId,
              context,
            );
      return { status: 200, body: result };
    }
    if (request.method === 'POST' && request.path === '/admin/v1/feature-flags/drafts') {
      const body = asRecord(request.body);
      if (
        body === null ||
        typeof body.flagKey !== 'string' ||
        typeof body.enabled !== 'boolean' ||
        !Object.hasOwn(body, 'rules')
      )
        return invalidRequest();
      return {
        status: 201,
        body: await this.dependencies.publication.createFeatureFlagDraft(
          { flagKey: body.flagKey, enabled: body.enabled, rules: body.rules },
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/feature-flags\/([0-9a-f-]+)\/preview$/i.exec(request.path);
    if (request.method === 'GET' && match !== null)
      return {
        status: 200,
        body: await this.dependencies.publication.getFeatureFlagVersion(match[1] ?? ''),
      };
    match = /^\/admin\/v1\/feature-flags\/([0-9a-f-]+)\/draft$/i.exec(request.path);
    if (request.method === 'PATCH' && match !== null) {
      const parsed = parseRevisionPatch(request.body, parseFeatureFlagPatch);
      if (parsed === null) return invalidRequest();
      return {
        status: 200,
        body: await this.dependencies.publication.updateFeatureFlagDraft(
          match[1] ?? '',
          parsed.expectedRevision,
          parsed.patch,
          principal.adminId,
        ),
      };
    }
    match = /^\/admin\/v1\/feature-flags\/([0-9a-f-]+)\/(publish|retire)$/i.exec(request.path);
    if (request.method === 'POST' && match !== null) {
      const revision = parseExpectedRevision(request.body);
      if (revision === null) return invalidRequest();
      const result =
        match[2] === 'publish'
          ? await this.dependencies.publication.publishFeatureFlag(
              match[1] ?? '',
              revision,
              principal.adminId,
              context,
            )
          : await this.dependencies.publication.retireFeatureFlag(
              match[1] ?? '',
              revision,
              principal.adminId,
              context,
            );
      return { status: 200, body: result };
    }
    return notFound(context.traceId);
  }

  async #adminSupport(
    request: OperationsHttpRequest,
    principal: AdminPrincipal,
    context: OperationRequestContext,
  ): Promise<OperationsHttpResponse> {
    const service = this.dependencies.ticket;
    if (service === undefined) return notFound(context.traceId);
    const invalid = (): OperationsHttpResponse =>
      apiError(400, 'INVALID_REQUEST', context.traceId, false);
    const denyUnless = (permission: string): OperationsHttpResponse | null =>
      principal.permissions.includes(permission)
        ? null
        : apiError(403, 'FORBIDDEN', context.traceId, false);
    if (request.method === 'GET' && request.path === '/admin/v1/feedback') {
      const denied = denyUnless('operations:feedback:read');
      if (denied !== null) return denied;
      const page = parsePage(request.query);
      if (page === null) return invalid();
      const result = await service.listFeedbackForAdmin(page);
      return { status: 200, body: { ...result, items: result.items.map(publicFeedback) } };
    }
    let match = /^\/admin\/v1\/tickets\/([0-9a-f-]+)$/i.exec(request.path);
    if (request.method === 'GET' && match !== null) {
      const denied = denyUnless('operations:tickets:read');
      if (denied !== null) return denied;
      if (!isUuidV7(match[1] ?? '')) return invalid();
      const result = await service.getForAdmin(match[1] ?? '');
      return { status: 200, body: { ...result, messages: result.messages.map(publicMessage) } };
    }
    if (principal.role !== 'OWNER' && principal.role !== 'ADMIN')
      return apiError(403, 'FORBIDDEN', context.traceId, false);
    match =
      /^\/admin\/v1\/tickets\/([0-9a-f-]+)\/(claim|reply|internal-notes|resolve|close)$/i.exec(
        request.path,
      );
    if (request.method !== 'POST' || match === null) return notFound(context.traceId);
    if (!isUuidV7(match[1] ?? '')) return invalid();
    const action = match[2] ?? '';
    const permission = `operations:tickets:${action === 'internal-notes' ? 'note' : action}`;
    const denied = denyUnless(permission);
    if (denied !== null) return denied;
    if (action === 'reply') {
      const body = parseTicketMessage(request.body);
      const key = singleHeader(request.headers, 'idempotency-key');
      if (body === null || key === null) return invalid();
      return {
        status: 201,
        body: ticketMessageResult(
          await service.reply(match[1] ?? '', body, principal.adminId, key, context),
        ),
      };
    }
    if (action === 'internal-notes') {
      const body = parseInternalNote(request.body);
      if (body === null) return invalid();
      return {
        status: 201,
        body: await service.addInternalNote(match[1] ?? '', body, principal.adminId),
      };
    }
    const revision = parseExpectedRevision(request.body);
    if (revision === null) return invalid();
    if (action === 'claim')
      return {
        status: 200,
        body: await service.claim(match[1] ?? '', revision, principal.adminId, context),
      };
    if (action === 'resolve')
      return {
        status: 200,
        body: await service.resolve(match[1] ?? '', revision, principal.adminId, context),
      };
    return {
      status: 200,
      body: await service.close(match[1] ?? '', revision, principal.adminId, context),
    };
  }
}

function normalizeHeaders(headers: RawHeaders | undefined): RawHeaders {
  return Object.fromEntries(
    Object.entries(headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function isContentKind(value: unknown): value is ContentKind {
  return ['BANNER', 'ANNOUNCEMENT', 'HELP', 'CASE_STUDY', 'LEGAL'].includes(String(value));
}
function parseExpectedRevision(value: unknown): number | null {
  const body = asRecord(value);
  return body !== null && isRevision(body.expectedRevision) ? body.expectedRevision : null;
}
function parseBigint(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}
function parseDate(value: unknown): Date | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? undefined : date;
}
function parsePackageDraft(value: unknown) {
  const body = asRecord(value);
  if (body === null) return null;
  const amountMinor = parseBigint(body.amountMinor);
  const points = parseBigint(body.points);
  const bonusPoints = parseBigint(body.bonusPoints);
  const activeFrom = parseDate(body.activeFrom);
  const activeUntil = parseDate(body.activeUntil);
  if (
    (body.activeFrom !== undefined && activeFrom === undefined) ||
    (body.activeUntil !== undefined && activeUntil === undefined)
  )
    return null;
  if (
    typeof body.name !== 'string' ||
    amountMinor === null ||
    body.currency !== 'CNY' ||
    points === null ||
    bonusPoints === null ||
    !(
      body.purchaseLimit === null ||
      (typeof body.purchaseLimit === 'number' && Number.isSafeInteger(body.purchaseLimit))
    ) ||
    !(
      body.validityDays === null ||
      (typeof body.validityDays === 'number' && Number.isSafeInteger(body.validityDays))
    ) ||
    !isRevision(body.sortOrder)
  )
    return null;
  return {
    name: body.name,
    amountMinor,
    currency: body.currency,
    points,
    bonusPoints,
    purchaseLimit: body.purchaseLimit,
    validityDays: body.validityDays,
    sortOrder: body.sortOrder,
    ...(activeFrom === undefined ? {} : { activeFrom }),
    ...(activeUntil === undefined ? {} : { activeUntil }),
  };
}
function parsePackagePatch(value: Record<string, unknown>): Partial<PackageDraftInput> | null {
  const patch: Partial<PackageDraftInput> = {};
  if (value.name !== undefined) {
    if (typeof value.name !== 'string') return null;
    patch.name = value.name;
  }
  for (const field of ['amountMinor', 'points', 'bonusPoints'] as const) {
    if (value[field] === undefined) continue;
    const parsed = parseBigint(value[field]);
    if (parsed === null) return null;
    patch[field] = parsed;
  }
  if (value.currency !== undefined) {
    if (value.currency !== 'CNY') return null;
    patch.currency = value.currency;
  }
  for (const field of ['purchaseLimit', 'validityDays'] as const) {
    const item = value[field];
    if (item === undefined) continue;
    if (!(item === null || (typeof item === 'number' && Number.isSafeInteger(item)))) return null;
    patch[field] = item;
  }
  if (value.sortOrder !== undefined) {
    if (!isRevision(value.sortOrder)) return null;
    patch.sortOrder = value.sortOrder;
  }
  for (const field of ['activeFrom', 'activeUntil'] as const) {
    if (value[field] === undefined) continue;
    const parsed = parseDate(value[field]);
    if (parsed === undefined) return null;
    patch[field] = parsed;
  }
  return patch;
}
function parseContentDraft(value: unknown) {
  const body = asRecord(value);
  if (
    body === null ||
    typeof body.title !== 'string' ||
    typeof body.summary !== 'string' ||
    typeof body.bodyHtml !== 'string' ||
    !isRevision(body.sortOrder)
  )
    return null;
  const activeFrom = parseDate(body.activeFrom);
  const activeUntil = parseDate(body.activeUntil);
  if (
    (body.activeFrom !== undefined && activeFrom === undefined) ||
    (body.activeUntil !== undefined && activeUntil === undefined) ||
    !(
      body.helpCategoryId === undefined ||
      body.helpCategoryId === null ||
      (typeof body.helpCategoryId === 'string' && isUuidV7(body.helpCategoryId))
    )
  )
    return null;
  return {
    title: body.title,
    summary: body.summary,
    bodyHtml: body.bodyHtml,
    sortOrder: body.sortOrder,
    ...(activeFrom === undefined ? {} : { activeFrom }),
    ...(activeUntil === undefined ? {} : { activeUntil }),
    ...(body.helpCategoryId === undefined ? {} : { helpCategoryId: body.helpCategoryId }),
  };
}
function parseContentPatch(value: Record<string, unknown>): Partial<ContentDraftInput> | null {
  const patch: Partial<ContentDraftInput> = {};
  for (const field of ['title', 'summary', 'bodyHtml'] as const) {
    if (value[field] === undefined) continue;
    if (typeof value[field] !== 'string') return null;
    patch[field] = value[field];
  }
  if (value.sortOrder !== undefined) {
    if (!isRevision(value.sortOrder)) return null;
    patch.sortOrder = value.sortOrder;
  }
  for (const field of ['activeFrom', 'activeUntil'] as const) {
    if (value[field] === undefined) continue;
    const parsed = parseDate(value[field]);
    if (parsed === undefined) return null;
    patch[field] = parsed;
  }
  if (value.helpCategoryId !== undefined) {
    if (!(
      value.helpCategoryId === null ||
      (typeof value.helpCategoryId === 'string' && isUuidV7(value.helpCategoryId))
    ))
      return null;
    patch.helpCategoryId = value.helpCategoryId;
  }
  return patch;
}
function parseRevisionPatch<T>(
  value: unknown,
  parse: (value: Record<string, unknown>) => T | null,
): { expectedRevision: number; patch: T } | null {
  const body = asRecord(value);
  if (body === null || !isRevision(body.expectedRevision)) return null;
  const { expectedRevision, ...rawPatch } = body;
  const patch = parse(rawPatch);
  return patch === null ? null : { expectedRevision, patch };
}
function parseBannerPlacement(value: unknown) {
  const body = asRecord(value);
  if (
    body === null ||
    typeof body.contentVersionId !== 'string' ||
    !isUuidV7(body.contentVersionId) ||
    typeof body.slot !== 'string' ||
    !isRevision(body.sortOrder) ||
    !isRevision(body.expectedRevision)
  )
    return null;
  const activeFrom = parseDate(body.activeFrom);
  const activeUntil = parseDate(body.activeUntil);
  if (
    (body.activeFrom !== undefined && activeFrom === undefined) ||
    (body.activeUntil !== undefined && activeUntil === undefined)
  )
    return null;
  return {
    contentVersionId: body.contentVersionId,
    slot: body.slot,
    sortOrder: body.sortOrder,
    expectedRevision: body.expectedRevision,
    activeFrom: activeFrom ?? null,
    activeUntil: activeUntil ?? null,
  };
}
function parseSystemSettingValue(
  value: Record<string, unknown>,
): { publicValue: unknown } | { kmsSecretReferenceId: string } | null {
  const hasPublic = Object.hasOwn(value, 'publicValue');
  const hasKms = Object.hasOwn(value, 'kmsSecretReferenceId');
  if (hasPublic === hasKms) return null;
  return hasPublic
    ? { publicValue: value.publicValue }
    : typeof value.kmsSecretReferenceId === 'string'
      ? { kmsSecretReferenceId: value.kmsSecretReferenceId }
      : null;
}
function parseFeatureFlagPatch(
  value: Record<string, unknown>,
): { enabled?: boolean; rules?: unknown } | null {
  const patch: { enabled?: boolean; rules?: unknown } = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') return null;
    patch.enabled = value.enabled;
  }
  if (Object.hasOwn(value, 'rules')) patch.rules = value.rules;
  return Object.keys(patch).length === 0 ? null : patch;
}
function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> | null {
  const body = asRecord(value);
  if (
    body === null ||
    Object.keys(body).some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(body, key))
  )
    return null;
  return body;
}
function parseAttachments(value: unknown): AttachmentInput[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 10) return null;
  const rows: AttachmentInput[] = [];
  for (const item of value) {
    const body = exactRecord(item, ['assetId', 'supportUploadSessionId'], ['assetId']);
    if (
      body === null ||
      typeof body.assetId !== 'string' ||
      !isUuidV7(body.assetId) ||
      !(
        body.supportUploadSessionId === undefined ||
        (typeof body.supportUploadSessionId === 'string' && isUuidV7(body.supportUploadSessionId))
      )
    )
      return null;
    rows.push({
      assetId: body.assetId,
      ...(typeof body.supportUploadSessionId === 'string'
        ? { supportUploadSessionId: body.supportUploadSessionId }
        : {}),
    });
  }
  return rows;
}
function parseTicketCreate(
  value: unknown,
): { subject: string; body: string; attachments: AttachmentInput[] } | null {
  const body = exactRecord(value, ['subject', 'body', 'attachments'], ['subject', 'body']);
  if (body === null || typeof body.subject !== 'string' || typeof body.body !== 'string')
    return null;
  const attachments = parseAttachments(body.attachments);
  return attachments === null ? null : { subject: body.subject, body: body.body, attachments };
}
function parseTicketMessage(
  value: unknown,
): { body: string; expectedRevision: number; attachments: AttachmentInput[] } | null {
  const body = exactRecord(
    value,
    ['body', 'expectedRevision', 'attachments'],
    ['body', 'expectedRevision'],
  );
  if (body === null || typeof body.body !== 'string' || !isRevision(body.expectedRevision))
    return null;
  const attachments = parseAttachments(body.attachments);
  return attachments === null
    ? null
    : { body: body.body, expectedRevision: body.expectedRevision, attachments };
}
function parseInternalNote(value: unknown): { body: string; expectedRevision: number } | null {
  const body = exactRecord(value, ['body', 'expectedRevision'], ['body', 'expectedRevision']);
  return body !== null && typeof body.body === 'string' && isRevision(body.expectedRevision)
    ? { body: body.body, expectedRevision: body.expectedRevision }
    : null;
}
function parseFeedback(value: unknown): {
  kind: FeedbackKind;
  taskId?: string;
  content: string;
  rating?: number;
  attachments: AttachmentInput[];
} | null {
  const body = exactRecord(
    value,
    ['kind', 'taskId', 'content', 'rating', 'attachments'],
    ['kind', 'content'],
  );
  if (
    body === null ||
    !['MODEL_RESULT', 'FAILED_TASK', 'PRODUCT_SUGGESTION'].includes(String(body.kind)) ||
    typeof body.content !== 'string' ||
    !(body.taskId === undefined || (typeof body.taskId === 'string' && isUuidV7(body.taskId))) ||
    !(
      body.rating === undefined ||
      (typeof body.rating === 'number' && Number.isInteger(body.rating))
    )
  )
    return null;
  const attachments = parseAttachments(body.attachments);
  if (attachments === null) return null;
  return {
    kind: body.kind as FeedbackKind,
    content: body.content,
    attachments,
    ...(typeof body.taskId === 'string' ? { taskId: body.taskId } : {}),
    ...(typeof body.rating === 'number' ? { rating: body.rating } : {}),
  };
}
function parsePage(
  value: Record<string, unknown> | undefined,
): { limit: number; cursor?: string } | null {
  const query = value ?? {};
  if (Object.keys(query).some((key) => key !== 'limit' && key !== 'cursor')) return null;
  const rawLimit = query.limit ?? 20;
  const limit =
    typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : rawLimit;
  if (
    !isRevision(limit) ||
    limit < 1 ||
    limit > 100 ||
    !(query.cursor === undefined || typeof query.cursor === 'string')
  )
    return null;
  return { limit, ...(typeof query.cursor === 'string' ? { cursor: query.cursor } : {}) };
}
function singleHeader(headers: RawHeaders | undefined, name: string): string | null {
  const value = normalizeHeaders(headers)[name];
  return typeof value === 'string' ? value : null;
}
function publicMessage(message: TicketMessage): Omit<
  TicketMessage,
  'idempotencyKey' | 'requestHash' | 'attachments'
> & {
  attachments: Array<{ id: string; assetId: string }>;
} {
  return {
    id: message.id,
    ticketId: message.ticketId,
    authorId: message.authorId,
    authorType: message.authorType,
    resolutionCycle: message.resolutionCycle,
    body: message.body,
    createdAt: message.createdAt,
    attachments: message.attachments.map(({ id, assetId }) => ({ id, assetId })),
  };
}
function userTicketView(result: Awaited<ReturnType<TicketService['get']>>): {
  ticket: typeof result.ticket;
  messages: ReturnType<typeof publicMessage>[];
} {
  return { ticket: result.ticket, messages: result.messages.map(publicMessage) };
}
function ticketMessageResult(result: Awaited<ReturnType<TicketService['addMessage']>>): {
  ticket: typeof result.ticket;
  message: ReturnType<typeof publicMessage>;
} {
  return { ticket: result.ticket, message: publicMessage(result.message) };
}
function publicFeedback(
  feedback: Feedback,
): Omit<Feedback, 'attachments'> & { attachments: Array<{ id: string; assetId: string }> } {
  return {
    ...feedback,
    attachments: feedback.attachments.map(({ id, assetId }) => ({ id, assetId })),
  };
}
function notFound(traceId: string): OperationsHttpResponse {
  return apiError(404, 'ROUTE_NOT_FOUND', traceId, false);
}
const CROSS_SERVICE_DOMAIN_ERROR_CODES = new Set(['FEEDBACK_SUBJECT_NOT_FOUND']);
function mapError(error: unknown, traceId: string): OperationsHttpResponse {
  const untrustedCode =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const code =
    error instanceof PublicationError || error instanceof TicketError
      ? error.code
      : CROSS_SERVICE_DOMAIN_ERROR_CODES.has(untrustedCode)
        ? untrustedCode
        : null;
  if (code === null) return apiError(500, 'INTERNAL_ERROR', traceId, true);
  if (code.includes('NOT_FOUND')) return apiError(404, code, traceId, false);
  if (
    code === 'VERSION_CONFLICT' ||
    code === 'TICKET_REVISION_CONFLICT' ||
    code === 'IDEMPOTENCY_CONFLICT'
  )
    return apiError(409, code, traceId, code !== 'IDEMPOTENCY_CONFLICT');
  return apiError(422, code, traceId, false);
}

function apiError(
  status: number,
  code: string,
  traceId: string,
  retryable: boolean,
  details?: unknown,
): OperationsHttpResponse {
  return {
    status,
    body: {
      code,
      message: code,
      traceId,
      retryable,
      ...(details === undefined ? {} : { details }),
    },
  };
}
function resolveTraceId(headers: RawHeaders | undefined): string {
  const incoming = normalizeHeaders(headers)['x-trace-id'];
  return typeof incoming === 'string' && /^[a-f0-9]{32}$/.test(incoming)
    ? incoming
    : randomBytes(16).toString('hex');
}
function resolveContext(
  headers: RawHeaders | undefined,
  traceId: string,
  id: () => string,
): OperationRequestContext {
  const normalized = normalizeHeaders(headers);
  const incoming = normalized['x-correlation-id'];
  const correlationId = typeof incoming === 'string' && isUuidV7(incoming) ? incoming : id();
  const causation = normalized['x-causation-id'];
  return {
    traceId,
    correlationId,
    ...(typeof causation === 'string' && isUuidV7(causation) ? { causationId: causation } : {}),
  };
}
function withTrace(response: OperationsHttpResponse, traceId: string): OperationsHttpResponse {
  return { ...response, headers: { ...response.headers, 'x-trace-id': traceId } };
}

function jsonResponse(response: OperationsHttpResponse): OperationsHttpResponse {
  return response.body === undefined ? response : { ...response, body: jsonValue(response.body) };
}

function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(jsonValue);
  if (typeof value === 'object' && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]));
  return value;
}
