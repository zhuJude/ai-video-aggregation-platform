import { types } from 'node:util';

import { createOutboundRequestContext, type OutboundRequestContext } from './outbound-request-context';
import { hasPermission } from './permissions';
import {
  assertAdminDataScope,
  requireAdminAuthorization,
  type AdminAuthorizationContext,
  type ServerGuardContext,
} from './server-guard';
import { isTraceId } from './trace-id';
import { isUuidV7 } from './uuid-v7';
import { canTransitionTicket } from './governance-policy';

export { canTransitionTicket } from './governance-policy';

export const CONTENT_OPERATIONS = ['SAVE_DRAFT', 'VALIDATE', 'PUBLISH', 'ROLLBACK', 'RETIRE', 'REORDER'] as const;
export const TICKET_STATUSES = ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'] as const;
export const TICKET_VISIBILITIES = ['PUBLIC_REPLY', 'INTERNAL_NOTE'] as const;
export const SYSTEM_OPERATIONS = [
  'SAVE_FLAG_DRAFT', 'VALIDATE_FLAG', 'PUBLISH_FLAG', 'ROLLBACK_FLAG',
  'SAVE_SETTING_DRAFT', 'VALIDATE_SETTING', 'PUBLISH_SETTING', 'ROLLBACK_SETTING', 'REDRIVE_DLQ',
] as const;
export type ContentOperation = (typeof CONTENT_OPERATIONS)[number];
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export type TicketVisibility = (typeof TICKET_VISIBILITIES)[number];
export type SystemOperation = (typeof SYSTEM_OPERATIONS)[number];

export type RichTextDocument = Readonly<{
  blocks: readonly Readonly<{
    text: string;
    type: 'HEADING' | 'LIST_ITEM' | 'PARAGRAPH';
  }>[];
}>;

type BaseRequest = Readonly<{
  requestContext: OutboundRequestContext;
  scope: 'ALL' | 'ASSIGNED' | 'OWN';
  trustedSessionToken: string;
}>;

type AuditCommand = Readonly<{
  idempotencyKey: string;
  reason: string;
}>;

export type ContentItem = Readonly<{
  allowedOperations: readonly ContentOperation[];
  assignedAdminIds: readonly string[];
  draft: Readonly<{ body: RichTextDocument; planPoints: string; title: string }>;
  draftPreviews: readonly Readonly<{
    expiresAt: string;
    operation: 'SAVE_DRAFT' | 'VALIDATE';
    preflightToken: string;
    resultStatus: 'DRAFT' | 'DRAFT_VALIDATED';
    resultVersion: number;
  }>[];
  id: string;
  ownerAdminId: string | null;
  preview: Readonly<{
    diff: readonly string[];
    expiresAt: string;
    operation: 'PUBLISH' | 'REORDER' | 'RETIRE' | 'ROLLBACK';
    preflightToken: string;
    renderedDocument: RichTextDocument;
    resultStatus: 'PUBLISHED' | 'RETIRED';
    resultVersion: number;
  }> | null;
  publishedVersion: number | null;
  slug: string;
  status: 'DRAFT' | 'DRAFT_VALIDATED' | 'PUBLISHED' | 'RETIRED';
  validation: Readonly<{ errors: readonly string[]; valid: boolean }>;
  version: number;
}>;

export type ContentDirectory = Readonly<{
  items: readonly ContentItem[];
  nextCursor: string | null;
  sourceUpdatedAt: string;
}>;

export type TicketMessage = Readonly<{
  attachments: readonly Readonly<{
    fileId: string;
    mimeType: 'application/pdf' | 'image/jpeg' | 'image/png';
    name: string;
    sizeBytes: number;
  }>[];
  authorMasked: string;
  authorType: 'ADMIN' | 'SYSTEM' | 'USER';
  body: string;
  createdAt: string;
  id: string;
  visibility: TicketVisibility;
}>;

export type TicketItem = Readonly<{
  allowedTransitions: readonly TicketStatus[];
  assignedAdminIds: readonly string[];
  id: string;
  messagePreviews: readonly Readonly<{
    allowedAttachmentFileIds: readonly string[];
    expiresAt: string;
    impact: string;
    preflightToken: string;
    resultVersion: number;
    visibility: TicketVisibility;
  }>[];
  messages: readonly TicketMessage[];
  ownerAdminId: string | null;
  resolvedAt: string | null;
  status: TicketStatus;
  transitionPreviews: readonly Readonly<{
    expiresAt: string;
    impact: string;
    preflightToken: string;
    resultVersion: number;
    to: TicketStatus;
  }>[];
  version: number;
}>;

export type TicketDirectory = Readonly<{
  items: readonly TicketItem[];
  nextCursor: string | null;
  sourceUpdatedAt: string;
}>;

export type RoleRecord = Readonly<{
  adminCount: number;
  assignedAdminIds: readonly string[];
  dataScope: 'ALL' | 'ASSIGNED' | 'OWN';
  id: string;
  isSuperAdmin: boolean;
  name: string;
  ownerAdminId: string | null;
  permissions: readonly string[];
  preview: Readonly<{
    actorImpacted: boolean;
    added: readonly string[];
    expiresAt: string;
    impactedAdminIdsMasked: readonly string[];
    operation: 'DELETE' | 'UPDATE';
    preflightToken: string;
    proposedDataScope: 'ALL' | 'ASSIGNED' | 'OWN' | null;
    proposedPermissions: readonly string[];
    removed: readonly string[];
    resultVersion: number;
  }> | null;
  version: number;
}>;

export type AdminAccountRecord = Readonly<{
  dataScope: 'ALL' | 'ASSIGNED' | 'OWN';
  displayNameMasked: string;
  id: string;
  mfa: Readonly<{ enabled: boolean; lastVerifiedAt: string | null }>;
  preview: Readonly<{
    actorImpacted: boolean;
    expiresAt: string;
    operation: 'UPDATE_ASSIGNMENTS' | 'UPDATE_SCOPE' | 'UPDATE_STATUS';
    preflightToken: string;
    proposedDataScope: 'ALL' | 'ASSIGNED' | 'OWN';
    proposedRoleIds: readonly string[];
    proposedStatus: 'ACTIVE' | 'DISABLED';
    removesLastSuperAdmin: boolean;
    resultVersion: number;
  }> | null;
  roleIds: readonly string[];
  status: 'ACTIVE' | 'DISABLED';
  version: number;
}>;

export type IamDirectory = Readonly<{
  admins: readonly AdminAccountRecord[];
  actorAdminId: string;
  grantablePermissions: readonly string[];
  roles: readonly RoleRecord[];
  sourceUpdatedAt: string;
  superAdminCount: number;
}>;

export type AuditFilters = Readonly<{
  action?: string;
  actor?: string;
  from?: string;
  resource?: string;
  to?: string;
  traceId?: string;
}>;

export type AuditDirectory = Readonly<{
  exportPreview: Readonly<{
    expiresAt: string;
    filterFingerprint: string;
    filters: Readonly<Record<keyof AuditFilters, string | null>>;
    preflightToken: string;
    resultStatus: 'QUEUED';
  }> | null;
  items: readonly Readonly<{
    action: string;
    actorIdMasked: string;
    afterSummary: string | null;
    at: string;
    beforeSummary: string | null;
    id: string;
    ipMasked: string;
    reason: string;
    resourceIdMasked: string;
    resourceType: string;
    traceId: string;
    userAgentMasked: string;
  }>[];
  nextCursor: string | null;
  sourceUpdatedAt: string;
}>;

export type SystemSnapshot = Readonly<{
  alerts: readonly Readonly<{
    closeCondition: string; id: string; ownerMasked: string; runbookUrl: string;
    severity: 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'; summary: string;
  }>[];
  config: Readonly<{
    allowedOperations: readonly SystemOperation[];
    featureFlags: Readonly<{
      current: readonly Readonly<{ enabled: boolean; key: string; rolloutBps: number }>[];
      diff: readonly string[];
      draft: readonly Readonly<{ enabled: boolean; key: string; rolloutBps: number }>[];
      history: readonly Readonly<{ publishedAt: string; version: number }>[];
      validation: Readonly<{ errors: readonly string[]; valid: boolean }>;
    }>;
    flagsVersion: number;
    preview: Readonly<{
      expiresAt: string;
      impact: string;
      operation: Exclude<SystemOperation, 'REDRIVE_DLQ'>;
      preflightToken: string;
      resultVersion: number;
    }> | null;
    publicSettings: Readonly<{
      current: Readonly<{ publicCallbackUrl: string; publicDomain: string }>;
      diff: readonly string[];
      draft: Readonly<{ publicCallbackUrl: string; publicDomain: string }>;
      history: readonly Readonly<{ publishedAt: string; version: number }>[];
      secretReferences: readonly Readonly<{ kmsReference: string; masked: string; name: string }>[];
      validation: Readonly<{ errors: readonly string[]; valid: boolean }>;
    }>;
    settingsVersion: number;
  }>;
  freshness: readonly Readonly<{ source: string; updatedAt: string }>[];
  links: readonly Readonly<{ label: string; url: string }>[];
  queues: readonly Readonly<{
    depth: string;
    dlq: number;
    name: string;
    preview: Readonly<{
      billingSafe: boolean;
      businessKey: string;
      currentOutcome: string;
      expiresAt: string;
      impact: string;
      idempotencySafe: boolean;
      preflightToken: string;
      purchaseSafe: boolean;
      resultVersion: number;
    }> | null;
    version: number;
  }>[];
  releases: readonly Readonly<{ deployedAt: string; digest: string; environment: string; service: string; version: string }>[];
  services: readonly Readonly<{ latencyMs: number; name: string; status: 'DEGRADED' | 'DOWN' | 'HEALTHY' }>[];
  sourceUpdatedAt: string;
}>;

export interface GovernanceOperationsPort {
  listContent(input: BaseRequest & Readonly<{ cursor?: string; status?: string }>): Promise<unknown>;
  getContent(input: BaseRequest & Readonly<{ contentId: string }>): Promise<unknown>;
  executeContentOperation(input: BaseRequest & Readonly<{
    actorId: string; audit: AuditCommand; confirmed: true; contentId: string; expectedVersion: number;
    operation: ContentOperation; preflightToken: string;
  }>): Promise<unknown>;
  saveContentDraft(input: BaseRequest & Readonly<{
    actorId: string; audit: AuditCommand; body: RichTextDocument; confirmed: true; contentId: string;
    expectedVersion: number; planPoints: string; preflightToken: string; title: string;
  }>): Promise<unknown>;
  validateContentDraft(input: BaseRequest & Readonly<{
    actorId: string; audit: AuditCommand; confirmed: true; contentId: string; expectedVersion: number;
    preflightToken: string;
  }>): Promise<unknown>;
  listTickets(input: BaseRequest & Readonly<{ cursor?: string; query?: string; status?: string }>): Promise<unknown>;
  getTicket(input: BaseRequest & Readonly<{ ticketId: string }>): Promise<unknown>;
  addPublicReply(input: BaseRequest & Readonly<{
    actorId: string; attachmentFileIds: readonly string[]; audit: AuditCommand; body: string; confirmed: true; expectedVersion: number;
    preflightToken: string; ticketId: string;
  }>): Promise<unknown>;
  addInternalNote(input: BaseRequest & Readonly<{
    actorId: string; attachmentFileIds: readonly string[]; audit: AuditCommand; body: string; confirmed: true; expectedVersion: number;
    preflightToken: string; ticketId: string;
  }>): Promise<unknown>;
  transitionTicket(input: BaseRequest & Readonly<{
    actorId: string; audit: AuditCommand; confirmed: true; expectedStatus: TicketStatus;
    expectedVersion: number; preflightToken: string; ticketId: string; to: TicketStatus;
  }>): Promise<unknown>;
  getIamDirectory(input: BaseRequest): Promise<unknown>;
  updateRole(input: BaseRequest & Readonly<{
    actorId: string; audit: AuditCommand; confirmed: true; dataScope: 'ALL' | 'ASSIGNED' | 'OWN' | null;
    expectedVersion: number; operation: 'DELETE' | 'UPDATE'; permissions: readonly string[]; preflightToken: string; roleId: string;
  }>): Promise<unknown>;
  updateAdmin(input: BaseRequest & Readonly<{
    actorId: string; adminId: string; audit: AuditCommand; confirmed: true; dataScope: 'ALL' | 'ASSIGNED' | 'OWN';
    expectedVersion: number; operation: 'UPDATE_ASSIGNMENTS' | 'UPDATE_SCOPE' | 'UPDATE_STATUS';
    preflightToken: string; roleIds: readonly string[]; status: 'ACTIVE' | 'DISABLED';
  }>): Promise<unknown>;
  listAudit(input: BaseRequest & AuditFilters & Readonly<{ cursor?: string }>): Promise<unknown>;
  getAuditExportPreview(input: BaseRequest & AuditFilters & Readonly<{ format: 'CSV' }>): Promise<unknown>;
  requestAuditExport(input: BaseRequest & AuditFilters & Readonly<{
    actorId: string; audit: AuditCommand; confirmed: true; filterFingerprint: string; format: 'CSV';
    preflightToken: string;
  }>): Promise<unknown>;
  getSystemSnapshot(input: BaseRequest): Promise<unknown>;
  executeSystemOperation(input: BaseRequest & Readonly<{
    actorId: string; audit: AuditCommand; confirmed: true; expectedVersion: number; operation: SystemOperation;
    preflightToken: string; resourceId: string;
    draft?: Readonly<{ enabled: boolean; flagKey: string; rolloutBps: number }> |
      Readonly<{ publicCallbackUrl: string; publicDomain: string; replacementSecret?: string }>;
  }>): Promise<unknown>;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return null;
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || keys.some((key) => !ownKeys.includes(key))) return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function exactArray(value: unknown, maximum: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum) return null;
    if (Reflect.ownKeys(value).some((key) => typeof key === 'symbol' || (key !== 'length' && !/^\d+$/u.test(key)))) return null;
    const output: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      output.push(descriptor.value);
    }
    return output;
  } catch {
    return null;
  }
}

function member<T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === 'string' && values.includes(value) ? value as T[number] : null;
}

const SECRET_TEXT = /(?:authorization\s*[:=]\s*(?:bearer|basic)|(?:set-)?cookie\s*[:=]|wechatpay-signature\s*:|api[-_ ]?key\s*[:=]|(?:password|private[-_ ]?key|secret|token|signature)\s*[:=]|[?&#](?:signature|token|secret)=)/iu;
const KMS_REFERENCE = /^kms:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$/u;
const POINTS = /^(?:0|[1-9]\d{0,59})$/u;

function isPrivateHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local') ||
      normalized.endsWith('.internal') || normalized === '::1' || normalized.startsWith('fc') ||
      normalized.startsWith('fd') || normalized.startsWith('fe80:')) return true;
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(normalized);
  if (!match) return false;
  const octets = match.slice(1).map(Number);
  return octets.some((octet) => octet > 255) || octets[0] === 10 || octets[0] === 127 ||
    octets[0] === 0 || octets[0] === 169 && octets[1] === 254 || octets[0] === 192 && octets[1] === 168 ||
    octets[0] === 172 && (octets[1] ?? 0) >= 16 && (octets[1] ?? 0) <= 31;
}

export function parsePublicHttpsUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2_048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port ||
        isPrivateHost(url.hostname) || !url.hostname.includes('.') || url.hostname.endsWith('.internal.example')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function parseTrustedObservabilityOrigins(value: string | readonly string[] | undefined): readonly string[] {
  const source = typeof value === 'string' ? value.split(',').map((item) => item.trim()).filter(Boolean) : value;
  if (!source || source.length === 0 || source.length > 20) throw new Error('可信观测域配置无效');
  const parsed = source.map((candidate) => parsePublicHttpsUrl(candidate));
  if (parsed.some((candidate, index) => !candidate || candidate !== `${String(source[index]).replace(/\/$/u, '')}/`)) {
    throw new Error('可信观测域配置无效');
  }
  return Object.freeze(parsed.map((candidate) => (candidate as string).slice(0, -1)));
}

function trustedLink(value: unknown, origins: readonly string[]): string | null {
  const parsed = parsePublicHttpsUrl(value);
  if (!parsed) return null;
  const origin = new URL(parsed).origin;
  return origins.includes(origin) ? parsed : null;
}

function safeText(value: unknown, maximum = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\p{C}]/u.test(value) && !SECRET_TEXT.test(value)
    ? value
    : null;
}

export function parseRichTextDocument(value: unknown): RichTextDocument | null {
  const document = exactRecord(value, ['blocks']);
  const source = exactArray(document?.blocks, 500);
  const blocks = source?.map((candidate) => {
    const block = exactRecord(candidate, ['text', 'type']);
    const text = safeText(block?.text, 20_000);
    const type = member(block?.type, ['HEADING', 'LIST_ITEM', 'PARAGRAPH'] as const);
    return block && text && type ? Object.freeze({ text, type }) : null;
  });
  if (!document || !blocks || blocks.length === 0 || blocks.some((block) => !block)) return null;
  return Object.freeze({ blocks: Object.freeze(blocks as RichTextDocument['blocks'] extends readonly (infer T)[] ? T[] : never) });
}

function utc(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function integer(value: unknown, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null;
}

function stringList(value: unknown, maximum: number, itemMaximum = 256): readonly string[] | null {
  const source = exactArray(value, maximum);
  if (!source) return null;
  const parsed = source.map((item) => safeText(item, itemMaximum));
  if (parsed.some((item) => item === null) || new Set(parsed).size !== parsed.length) return null;
  return Object.freeze(parsed as string[]);
}

function uuidList(value: unknown): readonly string[] | null {
  const source = exactArray(value, 100);
  if (!source || !source.every(isUuidV7)) return null;
  const parsed = source;
  if (new Set(parsed.map((id) => id.toLowerCase())).size !== parsed.length) return null;
  return Object.freeze([...parsed]);
}

function parseContentItem(value: unknown): ContentItem | null {
  const item = exactRecord(value, [
    'allowedOperations', 'assignedAdminIds', 'draft', 'draftPreviews', 'id', 'ownerAdminId', 'preview', 'publishedVersion',
    'slug', 'status', 'validation', 'version',
  ]);
  const allowedSource = exactArray(item?.allowedOperations, CONTENT_OPERATIONS.length);
  const allowedOperations = allowedSource?.map((operation) => member(operation, CONTENT_OPERATIONS));
  const assignedAdminIds = uuidList(item?.assignedAdminIds);
  const draft = exactRecord(item?.draft, ['body', 'planPoints', 'title']);
  const body = parseRichTextDocument(draft?.body);
  const planPoints = typeof draft?.planPoints === 'string' && POINTS.test(draft.planPoints) ? draft.planPoints : null;
  const title = safeText(draft?.title, 160);
  const draftPreviewsSource = exactArray(item?.draftPreviews, 2);
  const draftPreviews = draftPreviewsSource?.map((value) => {
    const preview = exactRecord(value, ['expiresAt', 'operation', 'preflightToken', 'resultStatus', 'resultVersion']);
    const expiresAt = utc(preview?.expiresAt);
    const operation = member(preview?.operation, ['SAVE_DRAFT', 'VALIDATE'] as const);
    const preflightToken = safeText(preview?.preflightToken, 500);
    const resultStatus = member(preview?.resultStatus, ['DRAFT', 'DRAFT_VALIDATED'] as const);
    const resultVersion = integer(preview?.resultVersion);
    if (!preview || !expiresAt || !operation || !preflightToken || !resultStatus || resultVersion === null ||
        (operation === 'SAVE_DRAFT' ? resultStatus !== 'DRAFT' : resultStatus !== 'DRAFT_VALIDATED')) return null;
    return Object.freeze({ expiresAt, operation, preflightToken, resultStatus, resultVersion });
  });
  const status = member(item?.status, ['DRAFT', 'DRAFT_VALIDATED', 'PUBLISHED', 'RETIRED'] as const);
  const slug = safeText(item?.slug, 120);
  const version = integer(item?.version);
  const publishedVersion = item?.publishedVersion === null ? null : integer(item?.publishedVersion);
  const validation = exactRecord(item?.validation, ['errors', 'valid']);
  const validationErrors = stringList(validation?.errors, 50, 500);
  const previewRecord = item?.preview === null ? null : exactRecord(item?.preview, [
    'diff', 'expiresAt', 'operation', 'preflightToken', 'renderedDocument', 'resultStatus', 'resultVersion',
  ]);
  const diff = previewRecord === null ? null : stringList(previewRecord.diff, 100, 1000);
  const expiresAt = previewRecord === null ? null : utc(previewRecord.expiresAt);
  const operation = previewRecord === null ? null : member(previewRecord.operation, ['PUBLISH', 'REORDER', 'RETIRE', 'ROLLBACK'] as const);
  const preflightToken = previewRecord === null ? null : safeText(previewRecord.preflightToken, 500);
  const renderedDocument = previewRecord === null ? null : parseRichTextDocument(previewRecord.renderedDocument);
  const resultStatus = previewRecord === null ? null : member(previewRecord.resultStatus, ['PUBLISHED', 'RETIRED'] as const);
  const resultVersion = previewRecord === null ? null : integer(previewRecord.resultVersion);
  if (!item || !allowedOperations || allowedOperations.some((operation) => !operation) ||
      new Set(allowedOperations).size !== allowedOperations.length || !assignedAdminIds || !draft || !body ||
      !planPoints || !title || !draftPreviews || draftPreviews.some((preview) => !preview) ||
      !isUuidV7(item.id) || (item.ownerAdminId !== null && !isUuidV7(item.ownerAdminId)) ||
      !slug || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || !status || version === null ||
      (item.publishedVersion !== null && publishedVersion === null) || !validation ||
      typeof validation.valid !== 'boolean' || !validationErrors ||
      (validation.valid !== (validationErrors.length === 0)) ||
      (item.preview !== null && (!previewRecord || !diff || !expiresAt || !operation || !preflightToken || !renderedDocument || !resultStatus || resultVersion === null)) ||
      allowedOperations.filter((candidate) => publicationOperations.includes(candidate as PublicationOperation)).length > 0 && item.preview === null ||
      allowedOperations.filter((operation) => operation === 'SAVE_DRAFT' || operation === 'VALIDATE')
        .some((operation) => !draftPreviews.some((preview) => preview?.operation === operation)) ||
      (operation && !allowedOperations.includes(operation)) ||
      (operation === 'PUBLISH' && (status !== 'DRAFT_VALIDATED' || !validation.valid || resultStatus !== 'PUBLISHED')) ||
      (operation === 'ROLLBACK' && (status !== 'PUBLISHED' || resultStatus !== 'PUBLISHED')) ||
      (operation === 'RETIRE' && (status !== 'PUBLISHED' || resultStatus !== 'RETIRED')) ||
      (operation === 'REORDER' && (status !== 'PUBLISHED' || resultStatus !== 'PUBLISHED'))) return null;
  return Object.freeze({
    allowedOperations: Object.freeze(allowedOperations as ContentOperation[]),
    assignedAdminIds,
    draft: Object.freeze({ body, planPoints, title }),
    draftPreviews: Object.freeze(draftPreviews as ContentItem['draftPreviews'] extends readonly (infer T)[] ? T[] : never),
    id: item.id,
    ownerAdminId: item.ownerAdminId,
    preview: previewRecord === null ? null : Object.freeze({
      diff: diff as readonly string[], expiresAt: expiresAt as string,
      operation: operation as NonNullable<ContentItem['preview']>['operation'], preflightToken: preflightToken as string,
      renderedDocument: renderedDocument as RichTextDocument, resultStatus: resultStatus as 'PUBLISHED' | 'RETIRED',
      resultVersion: resultVersion as number,
    }),
    publishedVersion,
    slug,
    status,
    validation: Object.freeze({ errors: validationErrors, valid: validation.valid }),
    version,
  });
}

export function parseContentDirectory(value: unknown): ContentDirectory {
  const payload = exactRecord(value, ['items', 'nextCursor', 'sourceUpdatedAt']);
  const source = exactArray(payload?.items, 200);
  const items = source?.map(parseContentItem);
  const nextCursor = payload?.nextCursor === null ? null : safeText(payload?.nextCursor, 500);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  if (!payload || !items || items.some((item) => !item) || nextCursor === null && payload.nextCursor !== null || !sourceUpdatedAt) throw new Error('内容响应无效');
  return Object.freeze({ items: Object.freeze(items as ContentItem[]), nextCursor, sourceUpdatedAt });
}

function parseTicketItem(value: unknown): TicketItem | null {
  const item = exactRecord(value, [
    'allowedTransitions', 'assignedAdminIds', 'id', 'messagePreviews', 'messages', 'ownerAdminId', 'resolvedAt',
    'status', 'transitionPreviews', 'version',
  ]);
  const allowedSource = exactArray(item?.allowedTransitions, TICKET_STATUSES.length);
  const allowedTransitions = allowedSource?.map((status) => member(status, TICKET_STATUSES));
  const assignedAdminIds = uuidList(item?.assignedAdminIds);
  const status = member(item?.status, TICKET_STATUSES);
  const resolvedAt = item?.resolvedAt === null ? null : utc(item?.resolvedAt);
  const version = integer(item?.version);
  const messagesSource = exactArray(item?.messages, 500);
  const messages = messagesSource?.map((value) => {
    const message = exactRecord(value, ['attachments', 'authorMasked', 'authorType', 'body', 'createdAt', 'id', 'visibility']);
    const authorMasked = safeText(message?.authorMasked, 120);
    const authorType = member(message?.authorType, ['ADMIN', 'SYSTEM', 'USER'] as const);
    const body = safeText(message?.body, 5000);
    const createdAt = utc(message?.createdAt);
    const visibility = member(message?.visibility, TICKET_VISIBILITIES);
    const attachmentsSource = exactArray(message?.attachments, 20);
    const attachments = attachmentsSource?.map((value) => {
      const attachment = exactRecord(value, ['fileId', 'mimeType', 'name', 'sizeBytes']);
      const mimeType = member(attachment?.mimeType, ['application/pdf', 'image/jpeg', 'image/png'] as const);
      const name = safeText(attachment?.name, 200);
      const sizeBytes = integer(attachment?.sizeBytes, 1, 20 * 1024 * 1024);
      return attachment && isUuidV7(attachment.fileId) && mimeType && name && sizeBytes !== null
        ? Object.freeze({ fileId: attachment.fileId, mimeType, name, sizeBytes }) : null;
    });
    return message && authorMasked && authorType && body && createdAt && isUuidV7(message.id) && visibility && attachments &&
      !attachments.some((attachment) => !attachment)
      ? Object.freeze({ attachments: Object.freeze(attachments as TicketMessage['attachments'] extends readonly (infer T)[] ? T[] : never), authorMasked, authorType, body, createdAt, id: message.id, visibility })
      : null;
  });
  const messagePreviewSource = exactArray(item?.messagePreviews, TICKET_VISIBILITIES.length);
  const messagePreviews = messagePreviewSource?.map((value) => {
    const preview = exactRecord(value, ['allowedAttachmentFileIds', 'expiresAt', 'impact', 'preflightToken', 'resultVersion', 'visibility']);
    const allowedAttachmentFileIds = uuidList(preview?.allowedAttachmentFileIds);
    const expiresAt = utc(preview?.expiresAt);
    const impact = safeText(preview?.impact, 1000);
    const preflightToken = safeText(preview?.preflightToken, 500);
    const resultVersion = integer(preview?.resultVersion);
    const visibility = member(preview?.visibility, TICKET_VISIBILITIES);
    return preview && allowedAttachmentFileIds && expiresAt && impact && preflightToken && resultVersion !== null && visibility
      ? Object.freeze({ allowedAttachmentFileIds, expiresAt, impact, preflightToken, resultVersion, visibility }) : null;
  });
  const transitionSource = exactArray(item?.transitionPreviews, TICKET_STATUSES.length);
  const transitionPreviews = transitionSource?.map((value) => {
    const preview = exactRecord(value, ['expiresAt', 'impact', 'preflightToken', 'resultVersion', 'to']);
    const expiresAt = utc(preview?.expiresAt);
    const impact = safeText(preview?.impact, 1000);
    const preflightToken = safeText(preview?.preflightToken, 500);
    const resultVersion = integer(preview?.resultVersion);
    const to = member(preview?.to, TICKET_STATUSES);
    return preview && expiresAt && impact && preflightToken && resultVersion !== null && to
      ? Object.freeze({ expiresAt, impact, preflightToken, resultVersion, to }) : null;
  });
  if (!item || !allowedTransitions || allowedTransitions.some((transition) => !transition) ||
      new Set(allowedTransitions).size !== allowedTransitions.length || !assignedAdminIds || !isUuidV7(item.id) ||
      (item.ownerAdminId !== null && !isUuidV7(item.ownerAdminId)) || !status ||
      (item.resolvedAt !== null && !resolvedAt) || ((status === 'RESOLVED' || status === 'CLOSED') !== (resolvedAt !== null)) ||
      version === null || !messages || messages.some((message) => !message) || !messagePreviews ||
      messagePreviews.some((preview) => !preview) || !transitionPreviews || transitionPreviews.some((preview) => !preview) ||
      allowedTransitions.some((to) => !transitionPreviews.some((preview) => preview?.to === to)) ||
      allowedTransitions.some((to) => !canTransitionTicket(status, to as TicketStatus, resolvedAt,
        messages.some((message) => message?.authorType === 'ADMIN' && message.visibility === 'PUBLIC_REPLY')))) return null;
  return Object.freeze({
    allowedTransitions: Object.freeze(allowedTransitions as TicketStatus[]), assignedAdminIds, id: item.id,
    messagePreviews: Object.freeze(messagePreviews as TicketItem['messagePreviews'] extends readonly (infer T)[] ? T[] : never),
    messages: Object.freeze(messages as TicketMessage[]), ownerAdminId: item.ownerAdminId, resolvedAt, status,
    transitionPreviews: Object.freeze(transitionPreviews as TicketItem['transitionPreviews'] extends readonly (infer T)[] ? T[] : never),
    version,
  });
}

export function parseTicketDirectory(value: unknown): TicketDirectory {
  const payload = exactRecord(value, ['items', 'nextCursor', 'sourceUpdatedAt']);
  const source = exactArray(payload?.items, 200);
  const items = source?.map(parseTicketItem);
  const nextCursor = payload?.nextCursor === null ? null : safeText(payload?.nextCursor, 500);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  if (!payload || !items || items.some((item) => !item) || nextCursor === null && payload.nextCursor !== null || !sourceUpdatedAt) throw new Error('工单响应无效');
  return Object.freeze({ items: Object.freeze(items as TicketItem[]), nextCursor, sourceUpdatedAt });
}

function parsePermissionList(value: unknown): readonly string[] | null {
  const source = stringList(value, 200, 64);
  return source && source.every((permission) => /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/u.test(permission)) ? source : null;
}

const DATA_SCOPES = ['ALL', 'ASSIGNED', 'OWN'] as const;

function parseRole(value: unknown): RoleRecord | null {
  const role = exactRecord(value, [
    'adminCount', 'assignedAdminIds', 'dataScope', 'id', 'isSuperAdmin', 'name', 'ownerAdminId', 'permissions', 'preview', 'version',
  ]);
  const adminCount = integer(role?.adminCount);
  const assignedAdminIds = uuidList(role?.assignedAdminIds);
  const dataScope = member(role?.dataScope, DATA_SCOPES);
  const name = safeText(role?.name, 100);
  const permissions = parsePermissionList(role?.permissions);
  const version = integer(role?.version);
  const previewRecord = role?.preview === null ? null : exactRecord(role?.preview, [
    'actorImpacted', 'added', 'expiresAt', 'impactedAdminIdsMasked', 'operation', 'preflightToken', 'proposedDataScope', 'proposedPermissions', 'removed', 'resultVersion',
  ]);
  const added = previewRecord === null ? null : parsePermissionList(previewRecord.added);
  const expiresAt = previewRecord === null ? null : utc(previewRecord.expiresAt);
  const impacted = previewRecord === null ? null : stringList(previewRecord.impactedAdminIdsMasked, 200, 120);
  const operation = previewRecord === null ? null : member(previewRecord.operation, ['DELETE', 'UPDATE'] as const);
  const preflightToken = previewRecord === null ? null : safeText(previewRecord.preflightToken, 500);
  const proposedDataScope = previewRecord === null ? null : previewRecord.proposedDataScope === null ? null : member(previewRecord.proposedDataScope, DATA_SCOPES);
  const proposedPermissions = previewRecord === null ? null : parsePermissionList(previewRecord.proposedPermissions);
  const removed = previewRecord === null ? null : parsePermissionList(previewRecord.removed);
  const resultVersion = previewRecord === null ? null : integer(previewRecord.resultVersion);
  if (!role || adminCount === null || !assignedAdminIds || !dataScope || !isUuidV7(role.id) || typeof role.isSuperAdmin !== 'boolean' ||
      !name || (role.ownerAdminId !== null && !isUuidV7(role.ownerAdminId)) || !permissions || version === null ||
      (role.preview !== null && (!previewRecord || typeof previewRecord.actorImpacted !== 'boolean' || !added || !expiresAt || !impacted || !operation || !preflightToken ||
        !proposedPermissions || !removed || resultVersion === null ||
        (operation === 'UPDATE' ? !proposedDataScope : proposedDataScope !== null) ||
        (operation === 'DELETE' && (proposedPermissions.length > 0 || added.length > 0))))) return null;
  return Object.freeze({
    adminCount, assignedAdminIds, dataScope, id: role.id, isSuperAdmin: role.isSuperAdmin, name,
    ownerAdminId: role.ownerAdminId, permissions,
    preview: previewRecord === null ? null : Object.freeze({ actorImpacted: previewRecord.actorImpacted as boolean,
      added: added as readonly string[], expiresAt: expiresAt as string,
      impactedAdminIdsMasked: impacted as readonly string[], operation: operation as 'DELETE' | 'UPDATE', preflightToken: preflightToken as string,
      proposedDataScope,
      proposedPermissions: proposedPermissions as readonly string[], removed: removed as readonly string[],
      resultVersion: resultVersion as number }),
    version,
  });
}

function parseAdminAccount(value: unknown): AdminAccountRecord | null {
  const admin = exactRecord(value, ['dataScope', 'displayNameMasked', 'id', 'mfa', 'preview', 'roleIds', 'status', 'version']);
  const dataScope = member(admin?.dataScope, DATA_SCOPES);
  const displayNameMasked = safeText(admin?.displayNameMasked, 120);
  const mfa = exactRecord(admin?.mfa, ['enabled', 'lastVerifiedAt']);
  const lastVerifiedAt = mfa?.lastVerifiedAt === null ? null : utc(mfa?.lastVerifiedAt);
  const roleIds = uuidList(admin?.roleIds);
  const status = member(admin?.status, ['ACTIVE', 'DISABLED'] as const);
  const version = integer(admin?.version);
  const previewRecord = admin?.preview === null ? null : exactRecord(admin?.preview, [
    'actorImpacted', 'expiresAt', 'operation', 'preflightToken', 'proposedDataScope', 'proposedRoleIds',
    'proposedStatus', 'removesLastSuperAdmin', 'resultVersion',
  ]);
  const expiresAt = previewRecord === null ? null : utc(previewRecord.expiresAt);
  const operation = previewRecord === null ? null : member(previewRecord.operation, ['UPDATE_ASSIGNMENTS', 'UPDATE_SCOPE', 'UPDATE_STATUS'] as const);
  const preflightToken = previewRecord === null ? null : safeText(previewRecord.preflightToken, 500);
  const proposedDataScope = previewRecord === null ? null : member(previewRecord.proposedDataScope, DATA_SCOPES);
  const proposedRoleIds = previewRecord === null ? null : uuidList(previewRecord.proposedRoleIds);
  const proposedStatus = previewRecord === null ? null : member(previewRecord.proposedStatus, ['ACTIVE', 'DISABLED'] as const);
  const resultVersion = previewRecord === null ? null : integer(previewRecord.resultVersion);
  if (!admin || !dataScope || !displayNameMasked || !isUuidV7(admin.id) || !mfa || typeof mfa.enabled !== 'boolean' ||
      (mfa.lastVerifiedAt !== null && !lastVerifiedAt) || !roleIds || !status || version === null ||
      (admin.preview !== null && (!previewRecord || typeof previewRecord.actorImpacted !== 'boolean' || !expiresAt || !operation ||
        !preflightToken || !proposedDataScope || !proposedRoleIds || !proposedStatus ||
        typeof previewRecord.removesLastSuperAdmin !== 'boolean' || resultVersion === null))) return null;
  return Object.freeze({ dataScope, displayNameMasked, id: admin.id, mfa: Object.freeze({ enabled: mfa.enabled, lastVerifiedAt }),
    preview: previewRecord === null ? null : Object.freeze({ actorImpacted: previewRecord.actorImpacted as boolean,
      expiresAt: expiresAt as string, operation: operation as NonNullable<AdminAccountRecord['preview']>['operation'],
      preflightToken: preflightToken as string, proposedDataScope: proposedDataScope as NonNullable<AdminAccountRecord['preview']>['proposedDataScope'],
      proposedRoleIds: proposedRoleIds as readonly string[], proposedStatus: proposedStatus as 'ACTIVE' | 'DISABLED',
      removesLastSuperAdmin: previewRecord.removesLastSuperAdmin as boolean, resultVersion: resultVersion as number }),
    roleIds, status, version });
}

export function parseIamDirectory(value: unknown): IamDirectory {
  const payload = exactRecord(value, ['actorAdminId', 'admins', 'grantablePermissions', 'roles', 'sourceUpdatedAt', 'superAdminCount']);
  const adminSource = exactArray(payload?.admins, 500);
  const admins = adminSource?.map(parseAdminAccount);
  const grantablePermissions = parsePermissionList(payload?.grantablePermissions);
  const rolesSource = exactArray(payload?.roles, 200);
  const roles = rolesSource?.map(parseRole);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  const superAdminCount = integer(payload?.superAdminCount, 1, 10_000);
  if (!payload || !isUuidV7(payload.actorAdminId) || !admins || admins.some((admin) => !admin) || !grantablePermissions ||
      !roles || roles.some((role) => !role) || !sourceUpdatedAt || superAdminCount === null) throw new Error('权限响应无效');
  const parsedAdmins = admins as AdminAccountRecord[];
  const parsedRoles = roles as RoleRecord[];
  const roleById = new Map(parsedRoles.map((role) => [role.id.toLowerCase(), role]));
  const hasDanglingAssignment = parsedAdmins.some((admin) => admin.roleIds.some((roleId) => !roleById.has(roleId.toLowerCase())));
  const hasInconsistentRoleCounts = parsedRoles.some((role) => {
    const assignedFromAdmins = parsedAdmins.filter((admin) => admin.roleIds.some((roleId) => roleId.toLowerCase() === role.id.toLowerCase()))
      .map((admin) => admin.id.toLowerCase());
    const declared = role.assignedAdminIds.map((adminId) => adminId.toLowerCase());
    return role.adminCount !== assignedFromAdmins.length || declared.length !== assignedFromAdmins.length ||
      declared.some((adminId) => !assignedFromAdmins.includes(adminId));
  });
  const derivedSuperAdminCount = parsedAdmins.filter((admin) => admin.status === 'ACTIVE' &&
    admin.roleIds.some((roleId) => roleById.get(roleId.toLowerCase())?.isSuperAdmin)).length;
  if (hasDanglingAssignment || hasInconsistentRoleCounts ||
      !parsedAdmins.some((admin) => admin.id.toLowerCase() === String(payload.actorAdminId).toLowerCase()) ||
      derivedSuperAdminCount !== superAdminCount) throw new Error('权限响应无效');
  return Object.freeze({ actorAdminId: payload.actorAdminId, admins: Object.freeze(admins as AdminAccountRecord[]), grantablePermissions,
    roles: Object.freeze(roles as RoleRecord[]), sourceUpdatedAt, superAdminCount });
}

export function parseAuditDirectory(value: unknown): AuditDirectory {
  const payload = exactRecord(value, ['exportPreview', 'items', 'nextCursor', 'sourceUpdatedAt']);
  const exportRecord = payload?.exportPreview === null ? null : exactRecord(payload?.exportPreview,
    ['expiresAt', 'filterFingerprint', 'filters', 'preflightToken', 'resultStatus']);
  const exportFiltersRecord = exportRecord === null ? null : exactRecord(exportRecord.filters,
    ['action', 'actor', 'from', 'resource', 'to', 'traceId']);
  const exportFilters = exportFiltersRecord === null ? null : Object.fromEntries(Object.entries(exportFiltersRecord).map(([key, value]) => [
    key, value === null ? null : safeText(value, key === 'traceId' ? 32 : 160),
  ])) as Record<keyof AuditFilters, string | null>;
  const exportExpiresAt = exportRecord === null ? null : utc(exportRecord.expiresAt);
  const exportFingerprint = exportRecord === null ? null : safeText(exportRecord.filterFingerprint, 200);
  const exportToken = exportRecord === null ? null : safeText(exportRecord.preflightToken, 500);
  const source = exactArray(payload?.items, 500);
  const items = source?.map((value) => {
    const item = exactRecord(value, ['action', 'actorIdMasked', 'afterSummary', 'at', 'beforeSummary', 'id', 'ipMasked', 'reason', 'resourceIdMasked', 'resourceType', 'traceId', 'userAgentMasked']);
    const action = safeText(item?.action, 120);
    const actorIdMasked = safeText(item?.actorIdMasked, 120);
    const afterSummary = item?.afterSummary === null ? null : safeText(item?.afterSummary, 1000);
    const at = utc(item?.at);
    const beforeSummary = item?.beforeSummary === null ? null : safeText(item?.beforeSummary, 1000);
    const ipMasked = safeText(item?.ipMasked, 120);
    const reason = safeText(item?.reason, 500);
    const resourceIdMasked = safeText(item?.resourceIdMasked, 160);
    const resourceType = safeText(item?.resourceType, 80);
    const userAgentMasked = safeText(item?.userAgentMasked, 300);
    return item && action && actorIdMasked && (item.afterSummary === null || afterSummary) && at &&
      (item.beforeSummary === null || beforeSummary) && isUuidV7(item.id) && ipMasked && reason && resourceIdMasked && resourceType && userAgentMasked &&
      isTraceId(item.traceId) ? Object.freeze({ action, actorIdMasked, at, id: item.id, reason, resourceIdMasked,
        afterSummary, beforeSummary, ipMasked, resourceType, traceId: item.traceId, userAgentMasked }) : null;
  });
  const nextCursor = payload?.nextCursor === null ? null : safeText(payload?.nextCursor, 500);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  if (!payload || !items || items.some((item) => !item) || nextCursor === null && payload.nextCursor !== null || !sourceUpdatedAt ||
      (payload.exportPreview !== null && (!exportRecord || !exportFilters || Object.values(exportFilters).some((value, index) =>
        value === null && Object.values(exportFiltersRecord as Record<string, unknown>)[index] !== null) || !exportExpiresAt || !exportFingerprint ||
        !exportToken || exportRecord.resultStatus !== 'QUEUED'))) throw new Error('审计响应无效');
  return Object.freeze({ exportPreview: exportRecord === null ? null : Object.freeze({ expiresAt: exportExpiresAt as string,
    filterFingerprint: exportFingerprint as string, filters: Object.freeze(exportFilters as Record<keyof AuditFilters, string | null>),
    preflightToken: exportToken as string, resultStatus: 'QUEUED' as const }),
  items: Object.freeze(items as AuditDirectory['items'] extends readonly (infer T)[] ? T[] : never), nextCursor, sourceUpdatedAt });
}

function parseFlagList(value: unknown) {
  const source = exactArray(value, 200);
  const items = source?.map((candidate) => {
    const flag = exactRecord(candidate, ['enabled', 'key', 'rolloutBps']);
    const key = safeText(flag?.key, 100);
    const rolloutBps = integer(flag?.rolloutBps, 0, 10_000);
    return flag && typeof flag.enabled === 'boolean' && key && /^[a-z][a-z0-9._-]*$/u.test(key) && rolloutBps !== null
      ? Object.freeze({ enabled: flag.enabled, key, rolloutBps }) : null;
  });
  return items && !items.some((item) => !item) ? Object.freeze(items as { enabled: boolean; key: string; rolloutBps: number }[]) : null;
}

function parseConfigHistory(value: unknown) {
  const source = exactArray(value, 100);
  const items = source?.map((candidate) => {
    const item = exactRecord(candidate, ['publishedAt', 'version']);
    const publishedAt = utc(item?.publishedAt);
    const version = integer(item?.version);
    return item && publishedAt && version !== null ? Object.freeze({ publishedAt, version }) : null;
  });
  return items && !items.some((item) => !item) ? Object.freeze(items as { publishedAt: string; version: number }[]) : null;
}

function parseValidation(value: unknown) {
  const validation = exactRecord(value, ['errors', 'valid']);
  const errors = stringList(validation?.errors, 100, 500);
  return validation && errors && typeof validation.valid === 'boolean' && validation.valid === (errors.length === 0)
    ? Object.freeze({ errors, valid: validation.valid }) : null;
}

function parsePublicSettings(value: unknown) {
  const settings = exactRecord(value, ['publicCallbackUrl', 'publicDomain']);
  const publicCallbackUrl = parsePublicHttpsUrl(settings?.publicCallbackUrl);
  const publicDomain = parsePublicHttpsUrl(settings?.publicDomain);
  return settings && publicCallbackUrl && publicDomain ? Object.freeze({ publicCallbackUrl, publicDomain }) : null;
}

export function parseSystemSnapshot(
  value: unknown,
  trustedOrigins = parseTrustedObservabilityOrigins(process.env.ADMIN_OBSERVABILITY_ALLOWED_ORIGINS),
): SystemSnapshot {
  const payload = exactRecord(value, ['alerts', 'config', 'freshness', 'links', 'queues', 'releases', 'services', 'sourceUpdatedAt']);
  const sourceUpdatedAt = utc(payload?.sourceUpdatedAt);
  const alertsSource = exactArray(payload?.alerts, 200);
  const alerts = alertsSource?.map((value) => {
    const item = exactRecord(value, ['closeCondition', 'id', 'ownerMasked', 'runbookUrl', 'severity', 'summary']);
    const closeCondition = safeText(item?.closeCondition, 500);
    const ownerMasked = safeText(item?.ownerMasked, 120);
    const runbookUrl = trustedLink(item?.runbookUrl, trustedOrigins);
    const severity = member(item?.severity, ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] as const);
    const summary = safeText(item?.summary, 500);
    return item && closeCondition && isUuidV7(item.id) && ownerMasked && runbookUrl && severity && summary
      ? Object.freeze({ closeCondition, id: item.id, ownerMasked, runbookUrl, severity, summary }) : null;
  });
  const servicesSource = exactArray(payload?.services, 100);
  const services = servicesSource?.map((value) => {
    const item = exactRecord(value, ['latencyMs', 'name', 'status']);
    const latencyMs = integer(item?.latencyMs, 0, 3_600_000);
    const name = safeText(item?.name, 100);
    const status = member(item?.status, ['DEGRADED', 'DOWN', 'HEALTHY'] as const);
    return item && latencyMs !== null && name && status ? Object.freeze({ latencyMs, name, status }) : null;
  });
  const freshnessSource = exactArray(payload?.freshness, 100);
  const freshness = freshnessSource?.map((value) => {
    const item = exactRecord(value, ['source', 'updatedAt']);
    const source = safeText(item?.source, 100);
    const updatedAt = utc(item?.updatedAt);
    return item && source && updatedAt ? Object.freeze({ source, updatedAt }) : null;
  });
  const releasesSource = exactArray(payload?.releases, 100);
  const releases = releasesSource?.map((value) => {
    const item = exactRecord(value, ['deployedAt', 'digest', 'environment', 'service', 'version']);
    const deployedAt = utc(item?.deployedAt);
    const environment = safeText(item?.environment, 40);
    const service = safeText(item?.service, 100);
    const version = safeText(item?.version, 100);
    return item && deployedAt && typeof item.digest === 'string' && /^[a-f0-9]{64}$/u.test(item.digest) && environment && service && version
      ? Object.freeze({ deployedAt, digest: item.digest, environment, service, version }) : null;
  });
  const linksSource = exactArray(payload?.links, 30);
  const links = linksSource?.map((value) => {
    const item = exactRecord(value, ['label', 'url']);
    const label = safeText(item?.label, 80);
    const url = trustedLink(item?.url, trustedOrigins);
    return item && label && url ? Object.freeze({ label, url }) : null;
  });
  const queueSource = exactArray(payload?.queues, 100);
  const queues = queueSource?.map((value) => {
    const item = exactRecord(value, ['depth', 'dlq', 'name', 'preview', 'version']);
    const depth = typeof item?.depth === 'string' && POINTS.test(item.depth) ? item.depth : null;
    const dlq = integer(item?.dlq);
    const name = safeText(item?.name, 100);
    const version = integer(item?.version);
    const previewRecord = item?.preview === null ? null : exactRecord(item?.preview, [
      'billingSafe', 'businessKey', 'currentOutcome', 'expiresAt', 'impact', 'idempotencySafe', 'preflightToken', 'purchaseSafe', 'resultVersion',
    ]);
    const businessKey = previewRecord === null ? null : safeText(previewRecord.businessKey, 200);
    const currentOutcome = previewRecord === null ? null : safeText(previewRecord.currentOutcome, 500);
    const expiresAt = previewRecord === null ? null : utc(previewRecord.expiresAt);
    const impact = previewRecord === null ? null : safeText(previewRecord.impact, 1000);
    const preflightToken = previewRecord === null ? null : safeText(previewRecord.preflightToken, 500);
    const resultVersion = previewRecord === null ? null : integer(previewRecord.resultVersion);
    return item && depth && dlq !== null && name && version !== null && (item.preview === null || previewRecord &&
      typeof previewRecord.billingSafe === 'boolean' && businessKey && currentOutcome && expiresAt && impact &&
      typeof previewRecord.idempotencySafe === 'boolean' && preflightToken && typeof previewRecord.purchaseSafe === 'boolean' && resultVersion !== null)
      ? Object.freeze({ depth, dlq, name, preview: previewRecord === null ? null : Object.freeze({
        billingSafe: previewRecord.billingSafe as boolean, businessKey: businessKey as string, currentOutcome: currentOutcome as string,
        expiresAt: expiresAt as string, impact: impact as string, idempotencySafe: previewRecord.idempotencySafe as boolean,
        preflightToken: preflightToken as string, purchaseSafe: previewRecord.purchaseSafe as boolean, resultVersion: resultVersion as number,
      }), version }) : null;
  });
  const config = exactRecord(payload?.config, ['allowedOperations', 'featureFlags', 'flagsVersion', 'preview', 'publicSettings', 'settingsVersion']);
  const allowedSource = exactArray(config?.allowedOperations, SYSTEM_OPERATIONS.length);
  const allowedOperations = allowedSource?.map((operation) => member(operation, SYSTEM_OPERATIONS));
  const flagsVersion = integer(config?.flagsVersion);
  const settingsVersion = integer(config?.settingsVersion);
  const flagRecord = exactRecord(config?.featureFlags, ['current', 'diff', 'draft', 'history', 'validation']);
  const currentFlags = parseFlagList(flagRecord?.current);
  const flagDiff = stringList(flagRecord?.diff, 200, 1000);
  const draftFlags = parseFlagList(flagRecord?.draft);
  const flagHistory = parseConfigHistory(flagRecord?.history);
  const flagValidation = parseValidation(flagRecord?.validation);
  const settingsRecord = exactRecord(config?.publicSettings, ['current', 'diff', 'draft', 'history', 'secretReferences', 'validation']);
  const currentSettings = parsePublicSettings(settingsRecord?.current);
  const settingsDiff = stringList(settingsRecord?.diff, 200, 1000);
  const draftSettings = parsePublicSettings(settingsRecord?.draft);
  const settingsHistory = parseConfigHistory(settingsRecord?.history);
  const settingsValidation = parseValidation(settingsRecord?.validation);
  const secretSource = exactArray(settingsRecord?.secretReferences, 100);
  const secretReferences = secretSource?.map((candidate) => {
    const item = exactRecord(candidate, ['kmsReference', 'masked', 'name']);
    const masked = safeText(item?.masked, 120);
    const name = safeText(item?.name, 100);
    return item && typeof item.kmsReference === 'string' && KMS_REFERENCE.test(item.kmsReference) && masked && masked.includes('***') && name
      ? Object.freeze({ kmsReference: item.kmsReference, masked, name }) : null;
  });
  const previewRecord = config?.preview === null ? null : exactRecord(config?.preview, ['expiresAt', 'impact', 'operation', 'preflightToken', 'resultVersion']);
  const configExpiresAt = previewRecord === null ? null : utc(previewRecord.expiresAt);
  const configImpact = previewRecord === null ? null : safeText(previewRecord.impact, 1000);
  const configOperation = previewRecord === null ? null : member(previewRecord.operation, SYSTEM_OPERATIONS.filter((item) => item !== 'REDRIVE_DLQ'));
  const configToken = previewRecord === null ? null : safeText(previewRecord.preflightToken, 500);
  const configResultVersion = previewRecord === null ? null : integer(previewRecord.resultVersion);
  const invalidFlagPublication = allowedOperations?.includes('PUBLISH_FLAG') && flagValidation?.valid !== true;
  const invalidSettingPublication = allowedOperations?.includes('PUBLISH_SETTING') && settingsValidation?.valid !== true;
  const missingRedriveCapability = queues?.some((queue) => queue?.preview !== null) && !allowedOperations?.includes('REDRIVE_DLQ');
  if (!payload || !sourceUpdatedAt || !alerts || alerts.some((item) => !item) || !services || services.some((item) => !item) ||
      !freshness || freshness.some((item) => !item) || !releases || releases.some((item) => !item) || !links || links.some((item) => !item) ||
      !queues || queues.some((item) => !item) || !config || !allowedOperations || allowedOperations.some((operation) => !operation) ||
      new Set(allowedOperations).size !== allowedOperations.length || flagsVersion === null || settingsVersion === null || !flagRecord ||
      !currentFlags || !flagDiff || !draftFlags || !flagHistory || !flagValidation || !settingsRecord || !currentSettings || !settingsDiff ||
      !draftSettings || !settingsHistory || !settingsValidation || !secretReferences || secretReferences.some((item) => !item) ||
      invalidFlagPublication || invalidSettingPublication || missingRedriveCapability ||
      (config.preview !== null && (!previewRecord || !configExpiresAt || !configImpact || !configOperation || !configToken || configResultVersion === null)) ||
      allowedOperations.filter((operation) => operation !== 'REDRIVE_DLQ').length > 0 && config.preview === null) throw new Error('系统运行响应无效');
  return Object.freeze({ alerts: Object.freeze(alerts as SystemSnapshot['alerts'] extends readonly (infer T)[] ? T[] : never),
    config: Object.freeze({ allowedOperations: Object.freeze(allowedOperations as SystemOperation[]),
      featureFlags: Object.freeze({ current: currentFlags, diff: flagDiff, draft: draftFlags, history: flagHistory, validation: flagValidation }),
      flagsVersion, preview: previewRecord === null ? null : Object.freeze({ expiresAt: configExpiresAt as string, impact: configImpact as string,
        operation: configOperation as Exclude<SystemOperation, 'REDRIVE_DLQ'>, preflightToken: configToken as string, resultVersion: configResultVersion as number }),
      publicSettings: Object.freeze({ current: currentSettings, diff: settingsDiff, draft: draftSettings, history: settingsHistory,
        secretReferences: Object.freeze(secretReferences as NonNullable<SystemSnapshot['config']['publicSettings']['secretReferences']> extends readonly (infer T)[] ? T[] : never),
        validation: settingsValidation }), settingsVersion }),
    freshness: Object.freeze(freshness as SystemSnapshot['freshness'] extends readonly (infer T)[] ? T[] : never),
    links: Object.freeze(links as SystemSnapshot['links'] extends readonly (infer T)[] ? T[] : never),
    queues: Object.freeze(queues as SystemSnapshot['queues'] extends readonly (infer T)[] ? T[] : never),
    releases: Object.freeze(releases as SystemSnapshot['releases'] extends readonly (infer T)[] ? T[] : never),
    services: Object.freeze(services as SystemSnapshot['services'] extends readonly (infer T)[] ? T[] : never), sourceUpdatedAt });
}

function base(authorization: AdminAuthorizationContext): BaseRequest {
  return { requestContext: createOutboundRequestContext(), scope: authorization.claims.dataScope,
    trustedSessionToken: authorization.trustedSessionToken };
}

function optionalFilter(value: string | undefined, maximum: number): string | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = safeText(value, maximum);
  if (!parsed) throw new Error('筛选条件无效');
  return parsed;
}

function formText(form: FormData, key: string, maximum: number): string | null {
  const value = form.get(key);
  return typeof value === 'string' ? safeText(value.trim(), maximum) : null;
}

function formVersion(form: FormData): number | null {
  const value = formText(form, 'expectedVersion', 16);
  if (!value || !/^\d{1,16}$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function commandFields(form: FormData, allowed: readonly string[], label: string) {
  if ([...form.keys()].some((key) => !allowed.includes(key))) throw new Error(`${label}字段无效`);
  const intentId = formText(form, 'intentId', 64);
  const preflightToken = formText(form, 'preflightToken', 500);
  const reason = formText(form, 'reason', 500);
  const expectedVersion = formVersion(form);
  if (!intentId || !isUuidV7(intentId) || !preflightToken || !reason || expectedVersion === null || form.get('confirmed') !== 'true') throw new Error(`${label}字段无效`);
  return { expectedVersion, intentId, preflightToken, reason };
}

function parseReceipt(value: unknown, expected: Readonly<{
  idempotencyKey: string; operation?: string; resourceId: string; resourceKey: string; status?: string; version?: number;
}>): Readonly<Record<string, unknown>> {
  const keys = ['auditRecordId', 'idempotencyKey', 'ok', 'requestId', expected.resourceKey,
    ...(expected.operation ? ['operation'] : []), ...(expected.status ? ['status'] : []), ...(expected.version === undefined ? [] : ['version'])];
  const receipt = exactRecord(value, keys);
  if (!receipt || receipt.ok !== true || receipt.idempotencyKey !== expected.idempotencyKey ||
      receipt[expected.resourceKey] !== expected.resourceId || !isUuidV7(receipt.auditRecordId) || !isUuidV7(receipt.requestId) ||
      (expected.operation !== undefined && receipt.operation !== expected.operation) ||
      (expected.status !== undefined && receipt.status !== expected.status) ||
      (expected.version !== undefined && receipt.version !== expected.version)) throw new Error('运营操作回执无效');
  return Object.freeze({ ...receipt });
}

export async function loadContentDirectory(input: Readonly<{
  context?: ServerGuardContext; cursor?: string; port: GovernanceOperationsPort; status?: string;
}>): Promise<ContentDirectory> {
  const authorization = await requireAdminAuthorization('content:read', input.context);
  const cursor = optionalFilter(input.cursor, 500);
  const status = optionalFilter(input.status, 40);
  const view = parseContentDirectory(await input.port.listContent({ ...base(authorization), ...(cursor ? { cursor } : {}), ...(status ? { status } : {}) }));
  if (authorization.claims.dataScope !== 'ALL') for (const item of view.items) assertAdminDataScope(authorization.claims, item);
  return view;
}

export async function loadTicketDirectory(input: Readonly<{
  context?: ServerGuardContext; cursor?: string; port: GovernanceOperationsPort; query?: string; status?: string;
}>): Promise<TicketDirectory> {
  const authorization = await requireAdminAuthorization('tickets:read', input.context);
  const cursor = optionalFilter(input.cursor, 500);
  const query = optionalFilter(input.query, 160);
  const status = optionalFilter(input.status, 40);
  const view = parseTicketDirectory(await input.port.listTickets({ ...base(authorization), ...(cursor ? { cursor } : {}), ...(query ? { query } : {}), ...(status ? { status } : {}) }));
  if (authorization.claims.dataScope !== 'ALL') for (const item of view.items) assertAdminDataScope(authorization.claims, item);
  return view;
}

export async function loadIamDirectory(input: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>): Promise<IamDirectory> {
  const authorization = await requireAdminAuthorization('iam:read', input.context);
  if (authorization.claims.dataScope !== 'ALL') throw new Error('权限管理仅允许全部数据范围');
  const directory = parseIamDirectory(await input.port.getIamDirectory(base(authorization)));
  if (directory.actorAdminId.toLowerCase() !== authorization.claims.subjectId.toLowerCase()) throw new Error('权限权威上下文不一致');
  return directory;
}

export async function loadAuditDirectory(input: Readonly<{
  action?: string; actor?: string; context?: ServerGuardContext; cursor?: string; from?: string; port: GovernanceOperationsPort;
  resource?: string; to?: string; traceId?: string;
}>): Promise<AuditDirectory> {
  const authorization = await requireAdminAuthorization('audit:read', input.context);
  if (authorization.claims.dataScope !== 'ALL') throw new Error('审计日志仅允许全部数据范围');
  const filters = parseAuditFilters(input);
  const cursor = optionalFilter(input.cursor, 500);
  return parseAuditDirectory(await input.port.listAudit({ ...base(authorization), ...filters, ...(cursor ? { cursor } : {}) }));
}

export async function loadSystemSnapshot(input: Readonly<{
  context?: ServerGuardContext; port: GovernanceOperationsPort; trustedObservabilityOrigins?: readonly string[];
}>): Promise<SystemSnapshot> {
  const authorization = await requireAdminAuthorization('system:read', input.context);
  if (authorization.claims.dataScope !== 'ALL') throw new Error('系统运行仅允许全部数据范围');
  return parseSystemSnapshot(await input.port.getSystemSnapshot(base(authorization)), input.trustedObservabilityOrigins);
}

const publicationOperations = ['PUBLISH', 'ROLLBACK', 'RETIRE', 'REORDER'] as const;
type PublicationOperation = (typeof publicationOperations)[number];
const contentPermission: Readonly<Record<PublicationOperation, string>> = Object.freeze({
  PUBLISH: 'content:publish', REORDER: 'content:reorder', RETIRE: 'content:retire', ROLLBACK: 'content:rollback',
});

function authoritativeDraftPreview(item: ContentItem, operation: 'SAVE_DRAFT' | 'VALIDATE', command: Readonly<{
  expectedVersion: number; preflightToken: string;
}>) {
  const preview = item.draftPreviews.find((candidate) => candidate.operation === operation);
  if (item.version !== command.expectedVersion || !item.allowedOperations.includes(operation) || !preview ||
      preview.preflightToken !== command.preflightToken || Date.parse(preview.expiresAt) <= Date.now()) throw new Error('内容草稿预检已失效');
  return preview;
}

export function createContentDraftAction(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  return async (form: FormData) => {
    const command = commandFields(form, ['bodyText', 'confirmed', 'contentId', 'expectedVersion', 'intentId', 'planPoints', 'preflightToken', 'reason', 'title'], '内容草稿');
    const authorization = await requireAdminAuthorization('content:write', dependencies.context);
    const contentId = formText(form, 'contentId', 64);
    const title = formText(form, 'title', 160);
    const bodyText = formText(form, 'bodyText', 20_000);
    const body = bodyText ? Object.freeze({ blocks: Object.freeze([Object.freeze({ text: bodyText, type: 'PARAGRAPH' as const })]) }) : null;
    const rawPoints = form.get('planPoints');
    const planPoints = typeof rawPoints === 'string' && POINTS.test(rawPoints) ? rawPoints : null;
    if (!contentId || !isUuidV7(contentId) || !title || !body || !planPoints) throw new Error('内容草稿字段无效');
    const requestBase = base(authorization);
    const item = parseContentItem(await dependencies.port.getContent({ ...requestBase, contentId }));
    if (!item) throw new Error('内容详情响应无效');
    assertAdminDataScope(authorization.claims, item);
    const preview = authoritativeDraftPreview(item, 'SAVE_DRAFT', command);
    const result = await dependencies.port.saveContentDraft({ ...requestBase, actorId: authorization.claims.subjectId,
      audit: { idempotencyKey: command.intentId, reason: command.reason }, body, confirmed: true, contentId,
      expectedVersion: command.expectedVersion, planPoints, preflightToken: command.preflightToken, title });
    return parseReceipt(result, { idempotencyKey: command.intentId, operation: 'SAVE_DRAFT', resourceId: contentId,
      resourceKey: 'contentId', status: preview.resultStatus, version: preview.resultVersion });
  };
}

export function createContentValidationAction(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  return async (form: FormData) => {
    const command = commandFields(form, ['confirmed', 'contentId', 'expectedVersion', 'intentId', 'preflightToken', 'reason'], '内容校验');
    const authorization = await requireAdminAuthorization('content:validate', dependencies.context);
    const contentId = formText(form, 'contentId', 64);
    if (!contentId || !isUuidV7(contentId)) throw new Error('内容校验字段无效');
    const requestBase = base(authorization);
    const item = parseContentItem(await dependencies.port.getContent({ ...requestBase, contentId }));
    if (!item) throw new Error('内容详情响应无效');
    assertAdminDataScope(authorization.claims, item);
    const preview = authoritativeDraftPreview(item, 'VALIDATE', command);
    const result = await dependencies.port.validateContentDraft({ ...requestBase, actorId: authorization.claims.subjectId,
      audit: { idempotencyKey: command.intentId, reason: command.reason }, confirmed: true, contentId,
      expectedVersion: command.expectedVersion, preflightToken: command.preflightToken });
    return parseReceipt(result, { idempotencyKey: command.intentId, operation: 'VALIDATE', resourceId: contentId,
      resourceKey: 'contentId', status: preview.resultStatus, version: preview.resultVersion });
  };
}

export function createContentPublicationAction(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  return async (form: FormData) => {
    const operation = member(form.get('operation'), publicationOperations);
    if (!operation) throw new Error('内容发布字段无效');
    const command = commandFields(form, ['confirmed', 'contentId', 'expectedVersion', 'intentId', 'operation', 'preflightToken', 'reason'], '内容发布');
    const authorization = await requireAdminAuthorization(contentPermission[operation], dependencies.context);
    const contentId = formText(form, 'contentId', 64);
    if (!contentId || !isUuidV7(contentId)) throw new Error('内容发布字段无效');
    const requestBase = base(authorization);
    const item = parseContentItem(await dependencies.port.getContent({ ...requestBase, contentId }));
    if (!item) throw new Error('内容详情响应无效');
    assertAdminDataScope(authorization.claims, item);
    const preview = item.preview;
    if (item.version !== command.expectedVersion || !item.allowedOperations.includes(operation) || !preview ||
        preview.operation !== operation || preview.preflightToken !== command.preflightToken || Date.parse(preview.expiresAt) <= Date.now() ||
        operation === 'PUBLISH' && (item.status !== 'DRAFT_VALIDATED' || !item.validation.valid || preview.resultStatus !== 'PUBLISHED')) throw new Error('内容发布预检已失效');
    const result = await dependencies.port.executeContentOperation({ ...requestBase, actorId: authorization.claims.subjectId,
      audit: { idempotencyKey: command.intentId, reason: command.reason }, confirmed: true, contentId,
      expectedVersion: command.expectedVersion, operation, preflightToken: command.preflightToken });
    return parseReceipt(result, { idempotencyKey: command.intentId, operation, resourceId: contentId,
      resourceKey: 'contentId', status: preview.resultStatus, version: preview.resultVersion });
  };
}

const ticketMessagePermission: Readonly<Record<TicketVisibility, string>> = Object.freeze({
  INTERNAL_NOTE: 'tickets:internal-note', PUBLIC_REPLY: 'tickets:public-reply',
});

export function createTicketMessageAction(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  return async (form: FormData) => {
    const visibility = member(form.get('visibility'), TICKET_VISIBILITIES);
    if (!visibility) throw new Error('工单消息字段无效');
    const command = commandFields(form, ['attachmentFileId', 'body', 'confirmed', 'expectedVersion', 'intentId', 'preflightToken', 'reason', 'ticketId', 'visibility'], '工单消息');
    const authorization = await requireAdminAuthorization(ticketMessagePermission[visibility], dependencies.context);
    const ticketId = formText(form, 'ticketId', 64);
    const body = formText(form, 'body', 5000);
    const attachmentFileIds = form.getAll('attachmentFileId');
    if (!ticketId || !isUuidV7(ticketId) || !body || !attachmentFileIds.every(isUuidV7) ||
        new Set(attachmentFileIds).size !== attachmentFileIds.length) throw new Error('工单消息字段无效');
    const requestBase = base(authorization);
    const item = parseTicketItem(await dependencies.port.getTicket({ ...requestBase, ticketId }));
    if (!item) throw new Error('工单详情响应无效');
    assertAdminDataScope(authorization.claims, item);
    const preview = item.messagePreviews.find((candidate) => candidate.visibility === visibility);
    if (item.version !== command.expectedVersion || !preview || preview.preflightToken !== command.preflightToken ||
        attachmentFileIds.some((fileId) => !preview.allowedAttachmentFileIds.includes(fileId)) ||
        Date.parse(preview.expiresAt) <= Date.now()) throw new Error('工单消息预检已失效');
    const mutation = { ...requestBase, actorId: authorization.claims.subjectId,
      attachmentFileIds: Object.freeze(attachmentFileIds), audit: {
      idempotencyKey: command.intentId, reason: command.reason }, body, confirmed: true as const,
      expectedVersion: command.expectedVersion, preflightToken: command.preflightToken, ticketId };
    const result = visibility === 'PUBLIC_REPLY'
      ? await dependencies.port.addPublicReply(mutation)
      : await dependencies.port.addInternalNote(mutation);
    const receipt = exactRecord(result, ['auditRecordId', 'idempotencyKey', 'messageVisibility', 'ok', 'requestId', 'ticketId', 'version']);
    if (!receipt || receipt.ok !== true || receipt.ticketId !== ticketId || receipt.idempotencyKey !== command.intentId ||
        receipt.messageVisibility !== visibility || receipt.version !== preview.resultVersion ||
        !isUuidV7(receipt.auditRecordId) || !isUuidV7(receipt.requestId)) throw new Error('运营操作回执无效');
    return Object.freeze({ ...receipt });
  };
}

export function createTicketTransitionAction(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  return async (form: FormData) => {
    const command = commandFields(form, ['confirmed', 'expectedStatus', 'expectedVersion', 'intentId', 'preflightToken', 'reason', 'ticketId', 'to'], '工单状态');
    const authorization = await requireAdminAuthorization('tickets:status-write', dependencies.context);
    const ticketId = formText(form, 'ticketId', 64);
    const expectedStatus = member(form.get('expectedStatus'), TICKET_STATUSES);
    const to = member(form.get('to'), TICKET_STATUSES);
    if (!ticketId || !isUuidV7(ticketId) || !expectedStatus || !to) throw new Error('工单状态字段无效');
    const requestBase = base(authorization);
    const item = parseTicketItem(await dependencies.port.getTicket({ ...requestBase, ticketId }));
    if (!item) throw new Error('工单详情响应无效');
    assertAdminDataScope(authorization.claims, item);
    const preview = item.transitionPreviews.find((candidate) => candidate.to === to);
    if (item.status !== expectedStatus || item.version !== command.expectedVersion || !item.allowedTransitions.includes(to) ||
        !canTransitionTicket(item.status, to, item.resolvedAt,
          item.messages.some((message) => message.authorType === 'ADMIN' && message.visibility === 'PUBLIC_REPLY')) ||
        !preview || preview.preflightToken !== command.preflightToken ||
        Date.parse(preview.expiresAt) <= Date.now()) throw new Error('工单状态预检已失效');
    const result = await dependencies.port.transitionTicket({ ...requestBase, actorId: authorization.claims.subjectId,
      audit: { idempotencyKey: command.intentId, reason: command.reason }, confirmed: true, expectedStatus,
      expectedVersion: command.expectedVersion, preflightToken: command.preflightToken, ticketId, to });
    return parseReceipt(result, { idempotencyKey: command.intentId, resourceId: ticketId, resourceKey: 'ticketId',
      status: to, version: preview.resultVersion });
  };
}

export function createRoleUpdateAction(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  return async (form: FormData) => {
    const operation = member(form.get('operation'), ['DELETE', 'UPDATE'] as const);
    if (!operation) throw new Error('角色变更字段无效');
    const command = commandFields(form, ['confirmed', 'dataScope', 'expectedVersion', 'intentId', 'operation', 'permission', 'preflightToken', 'reason', 'roleId'], '角色变更');
    const authorization = await requireAdminAuthorization(operation === 'DELETE' ? 'iam:role-delete' : 'iam:role-write', dependencies.context);
    if (authorization.claims.dataScope !== 'ALL') throw new Error('权限管理仅允许全部数据范围');
    const roleId = formText(form, 'roleId', 64);
    const permissionValues = form.getAll('permission');
    const permissions = parsePermissionList(permissionValues);
    const dataScope = operation === 'DELETE' ? null : member(form.get('dataScope'), DATA_SCOPES);
    if (!roleId || !isUuidV7(roleId) || !permissions || (operation === 'UPDATE' && !dataScope)) throw new Error('角色变更字段无效');
    const requestBase = base(authorization);
    const directory = parseIamDirectory(await dependencies.port.getIamDirectory(requestBase));
    if (directory.actorAdminId.toLowerCase() !== authorization.claims.subjectId.toLowerCase()) throw new Error('权限权威上下文不一致');
    const role = directory.roles.find((candidate) => candidate.id === roleId);
    if (!role || role.version !== command.expectedVersion || !role.preview || role.preview.operation !== operation ||
        role.preview.preflightToken !== command.preflightToken || Date.parse(role.preview.expiresAt) <= Date.now()) throw new Error('角色变更预检已失效');
    if (operation === 'UPDATE' && permissions.some((permission) => !directory.grantablePermissions.includes(permission) ||
        !hasPermission(authorization.claims, permission))) throw new Error('不可授予未持有权限');
    if (permissions.length !== role.preview.proposedPermissions.length || permissions.some((permission, index) => permission !== role.preview?.proposedPermissions[index]) ||
        dataScope !== role.preview.proposedDataScope) throw new Error('角色变更预检已失效');
    const scopeRank = { ALL: 3, ASSIGNED: 2, OWN: 1 } as const;
    const actorImpacted = role.assignedAdminIds.some((adminId) => adminId.toLowerCase() === authorization.claims.subjectId.toLowerCase());
    if (actorImpacted && (role.preview.added.length > 0 || dataScope && scopeRank[dataScope] > scopeRank[role.dataScope])) throw new Error('不可通过当前角色为自己提权');
    if (operation === 'DELETE' && role.isSuperAdmin && directory.superAdminCount === 1) throw new Error('不可删除最后一名超级管理员');
    const result = await dependencies.port.updateRole({ ...requestBase, actorId: authorization.claims.subjectId,
      audit: { idempotencyKey: command.intentId, reason: command.reason }, confirmed: true,
      dataScope, expectedVersion: command.expectedVersion, operation, permissions, preflightToken: command.preflightToken, roleId });
    return parseReceipt(result, { idempotencyKey: command.intentId, resourceId: roleId, resourceKey: 'roleId',
      operation, version: role.preview.resultVersion });
  };
}

export function createAdminUpdateAction(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  return async (form: FormData) => {
    const operation = member(form.get('operation'), ['UPDATE_ASSIGNMENTS', 'UPDATE_SCOPE', 'UPDATE_STATUS'] as const);
    if (!operation) throw new Error('管理员变更字段无效');
    const command = commandFields(form, ['adminId', 'confirmed', 'dataScope', 'expectedVersion', 'intentId', 'operation', 'preflightToken', 'reason', 'roleId', 'status'], '管理员变更');
    const authorization = await requireAdminAuthorization('iam:admin-write', dependencies.context);
    if (authorization.claims.dataScope !== 'ALL') throw new Error('权限管理仅允许全部数据范围');
    const adminId = formText(form, 'adminId', 64);
    const dataScope = member(form.get('dataScope'), DATA_SCOPES);
    const roleIds = uuidList(form.getAll('roleId'));
    const status = member(form.get('status'), ['ACTIVE', 'DISABLED'] as const);
    if (!adminId || !isUuidV7(adminId) || !dataScope || !roleIds || !status) throw new Error('管理员变更字段无效');
    const requestBase = base(authorization);
    const directory = parseIamDirectory(await dependencies.port.getIamDirectory(requestBase));
    if (directory.actorAdminId.toLowerCase() !== authorization.claims.subjectId.toLowerCase()) throw new Error('权限权威上下文不一致');
    const admin = directory.admins.find((candidate) => candidate.id === adminId);
    const preview = admin?.preview;
    if (!admin || admin.version !== command.expectedVersion || !preview || preview.operation !== operation ||
        preview.preflightToken !== command.preflightToken || Date.parse(preview.expiresAt) <= Date.now() ||
        dataScope !== preview.proposedDataScope || status !== preview.proposedStatus || roleIds.length !== preview.proposedRoleIds.length ||
        roleIds.some((id, index) => id !== preview.proposedRoleIds[index])) throw new Error('管理员变更预检已失效');
    const targetRoles = roleIds.map((roleId) => directory.roles.find((role) => role.id.toLowerCase() === roleId.toLowerCase()));
    if (targetRoles.some((role) => !role)) throw new Error('管理员变更预检已失效');
    const targetPermissions = new Set(targetRoles.flatMap((role) => role?.permissions ?? []));
    if ([...targetPermissions].some((permission) => !directory.grantablePermissions.includes(permission) ||
        !hasPermission(authorization.claims, permission))) throw new Error('不可分配未持有权限的角色');
    const currentRoles = admin.roleIds.map((roleId) => directory.roles.find((role) => role.id.toLowerCase() === roleId.toLowerCase()));
    const currentPermissions = new Set(currentRoles.flatMap((role) => role?.permissions ?? []));
    const actorImpacted = admin.id.toLowerCase() === authorization.claims.subjectId.toLowerCase();
    if (actorImpacted && status === 'ACTIVE' && ([...targetPermissions].some((permission) => !currentPermissions.has(permission)) ||
        ({ ALL: 3, ASSIGNED: 2, OWN: 1 } as const)[dataScope] > ({ ALL: 3, ASSIGNED: 2, OWN: 1 } as const)[admin.dataScope])) {
      throw new Error('不可为自己提权');
    }
    const currentIsSuperAdmin = admin.status === 'ACTIVE' && currentRoles.some((role) => role?.isSuperAdmin);
    const targetIsSuperAdmin = status === 'ACTIVE' && targetRoles.some((role) => role?.isSuperAdmin);
    if (currentIsSuperAdmin && !targetIsSuperAdmin && directory.superAdminCount === 1) throw new Error('不可移除最后一名超级管理员');
    const result = await dependencies.port.updateAdmin({ ...requestBase, actorId: authorization.claims.subjectId, adminId,
      audit: { idempotencyKey: command.intentId, reason: command.reason }, confirmed: true, dataScope,
      expectedVersion: command.expectedVersion, operation, preflightToken: command.preflightToken, roleIds, status });
    return parseReceipt(result, { idempotencyKey: command.intentId, operation, resourceId: adminId, resourceKey: 'adminId',
      status, version: preview.resultVersion });
  };
}

function parseAuditFilters(source: AuditFilters): AuditFilters {
  const actor = optionalFilter(source.actor, 120);
  const action = optionalFilter(source.action, 120);
  const resource = optionalFilter(source.resource, 160);
  const traceId = optionalFilter(source.traceId, 32);
  const from = source.from === undefined || source.from === '' ? undefined : utc(source.from) ?? undefined;
  const to = source.to === undefined || source.to === '' ? undefined : utc(source.to) ?? undefined;
  if ((source.traceId && (!traceId || !isTraceId(traceId))) || (source.from && !from) || (source.to && !to) ||
      from && to && Date.parse(from) > Date.parse(to)) throw new Error('审计筛选条件无效');
  return { ...(action ? { action } : {}), ...(actor ? { actor } : {}), ...(from ? { from } : {}),
    ...(resource ? { resource } : {}), ...(to ? { to } : {}), ...(traceId ? { traceId } : {}) };
}

function parseAuditExportPreview(value: unknown) {
  const preview = exactRecord(value, ['expiresAt', 'filterFingerprint', 'preflightToken', 'resultStatus']);
  const expiresAt = utc(preview?.expiresAt);
  const filterFingerprint = safeText(preview?.filterFingerprint, 200);
  const preflightToken = safeText(preview?.preflightToken, 500);
  if (!preview || !expiresAt || !filterFingerprint || !preflightToken || preview.resultStatus !== 'QUEUED') throw new Error('审计导出预检响应无效');
  return Object.freeze({ expiresAt, filterFingerprint, preflightToken, resultStatus: 'QUEUED' as const });
}

export function createAuditExportAction(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  return async (form: FormData) => {
    if ([...form.keys()].some((key) => !['action', 'actor', 'confirmed', 'filterFingerprint', 'format', 'from', 'intentId', 'preflightToken', 'reason', 'resource', 'to', 'traceId'].includes(key))) throw new Error('审计导出字段无效');
    const authorization = await requireAdminAuthorization('audit:export', dependencies.context);
    if (authorization.claims.dataScope !== 'ALL') throw new Error('审计导出仅允许全部数据范围');
    const intentId = formText(form, 'intentId', 64);
    const reason = formText(form, 'reason', 500);
    const preflightToken = formText(form, 'preflightToken', 500);
    const filterFingerprint = formText(form, 'filterFingerprint', 200);
    if (!intentId || !isUuidV7(intentId) || !reason || !preflightToken || !filterFingerprint || form.get('format') !== 'CSV' || form.get('confirmed') !== 'true') throw new Error('审计导出字段无效');
    const action = formText(form, 'action', 120);
    const actor = formText(form, 'actor', 120);
    const from = formText(form, 'from', 40);
    const resource = formText(form, 'resource', 160);
    const to = formText(form, 'to', 40);
    const traceId = formText(form, 'traceId', 32);
    const filters = parseAuditFilters({ ...(action ? { action } : {}), ...(actor ? { actor } : {}),
      ...(from ? { from } : {}), ...(resource ? { resource } : {}), ...(to ? { to } : {}),
      ...(traceId ? { traceId } : {}) });
    const requestBase = base(authorization);
    const preview = parseAuditExportPreview(await dependencies.port.getAuditExportPreview({ ...requestBase, ...filters, format: 'CSV' }));
    if (preview.preflightToken !== preflightToken || preview.filterFingerprint !== filterFingerprint || Date.parse(preview.expiresAt) <= Date.now()) throw new Error('审计导出预检已失效');
    const result = await dependencies.port.requestAuditExport({ ...requestBase, ...filters,
      actorId: authorization.claims.subjectId, audit: { idempotencyKey: intentId, reason }, confirmed: true,
      filterFingerprint, format: 'CSV', preflightToken });
    const receipt = exactRecord(result, ['auditRecordId', 'exportJobId', 'filterFingerprint', 'idempotencyKey', 'ok', 'requestId', 'status']);
    if (!receipt || receipt.ok !== true || !isUuidV7(receipt.auditRecordId) || !isUuidV7(receipt.exportJobId) ||
        !isUuidV7(receipt.requestId) || receipt.idempotencyKey !== intentId || receipt.filterFingerprint !== filterFingerprint ||
        receipt.status !== preview.resultStatus) throw new Error('运营操作回执无效');
    return Object.freeze({ ...receipt });
  };
}

const systemPermission: Readonly<Record<SystemOperation, string>> = Object.freeze({
  SAVE_FLAG_DRAFT: 'system:config-write', SAVE_SETTING_DRAFT: 'system:config-write',
  VALIDATE_FLAG: 'system:config-write', VALIDATE_SETTING: 'system:config-write',
  PUBLISH_FLAG: 'system:config-publish', PUBLISH_SETTING: 'system:config-publish',
  REDRIVE_DLQ: 'system:dlq-redrive', ROLLBACK_FLAG: 'system:config-rollback',
  ROLLBACK_SETTING: 'system:config-rollback',
});

export function createSystemMutationAction(dependencies: Readonly<{
  context?: ServerGuardContext; port: GovernanceOperationsPort; trustedObservabilityOrigins?: readonly string[];
}>) {
  return async (form: FormData) => {
    const operation = member(form.get('operation'), SYSTEM_OPERATIONS);
    if (!operation) throw new Error('系统操作字段无效');
    const allowedFields = ['confirmed', 'expectedVersion', 'intentId', 'operation', 'preflightToken', 'reason', 'resourceId',
      ...(operation === 'SAVE_FLAG_DRAFT' ? ['enabled', 'flagKey', 'rolloutBps'] : []),
      ...(operation === 'SAVE_SETTING_DRAFT' ? ['publicCallbackUrl', 'publicDomain', 'replacementSecret'] : [])];
    const command = commandFields(form, allowedFields, '系统操作');
    const authorization = await requireAdminAuthorization(systemPermission[operation], dependencies.context);
    if (authorization.claims.dataScope !== 'ALL') throw new Error('系统操作仅允许全部数据范围');
    const resourceId = formText(form, 'resourceId', 120);
    if (!resourceId) throw new Error('系统操作字段无效');
    const requestBase = base(authorization);
    const snapshot = parseSystemSnapshot(await dependencies.port.getSystemSnapshot(requestBase), dependencies.trustedObservabilityOrigins);
    let preview: {
      billingSafe?: boolean; businessKey?: string; currentOutcome?: string; expiresAt: string;
      idempotencySafe?: boolean; preflightToken: string; purchaseSafe?: boolean; resultVersion: number;
    } | null;
    if (operation === 'REDRIVE_DLQ') {
      const queue = snapshot.queues.find((candidate) => candidate.name === resourceId);
      if (!snapshot.config.allowedOperations.includes('REDRIVE_DLQ') || !queue || queue.version !== command.expectedVersion) throw new Error('系统操作预检已失效');
      preview = queue.preview;
      if (!preview?.idempotencySafe || !preview.billingSafe || !preview.purchaseSafe) throw new Error('DLQ 重放安全条件不满足');
    } else {
      if (!snapshot.config.allowedOperations.includes(operation) || snapshot.config.preview?.operation !== operation ||
          operation === 'PUBLISH_FLAG' && !snapshot.config.featureFlags.validation.valid ||
          operation === 'PUBLISH_SETTING' && !snapshot.config.publicSettings.validation.valid ||
          (operation.includes('FLAG') ? snapshot.config.flagsVersion : snapshot.config.settingsVersion) !== command.expectedVersion) throw new Error('系统操作预检已失效');
      preview = snapshot.config.preview;
    }
    if (preview.preflightToken !== command.preflightToken || Date.parse(preview.expiresAt) <= Date.now()) throw new Error('系统操作预检已失效');
    let draft: NonNullable<Parameters<GovernanceOperationsPort['executeSystemOperation']>[0]['draft']> | undefined;
    if (operation === 'SAVE_FLAG_DRAFT') {
      const flagKey = formText(form, 'flagKey', 100);
      const rolloutRaw = formText(form, 'rolloutBps', 5);
      const enabled = form.get('enabled');
      const rolloutBps = rolloutRaw && /^\d{1,5}$/u.test(rolloutRaw) ? Number(rolloutRaw) : Number.NaN;
      if (!flagKey || !/^[a-z][a-z0-9._-]*$/u.test(flagKey) || !Number.isSafeInteger(rolloutBps) || rolloutBps > 10_000 ||
          typeof enabled !== 'string' || !['true', 'false'].includes(enabled)) throw new Error('系统操作字段无效');
      draft = { enabled: enabled === 'true', flagKey, rolloutBps };
    } else if (operation === 'SAVE_SETTING_DRAFT') {
      const publicCallbackUrl = parsePublicHttpsUrl(form.get('publicCallbackUrl'));
      const publicDomain = parsePublicHttpsUrl(form.get('publicDomain'));
      const rawSecret = form.get('replacementSecret');
      if (!publicCallbackUrl || !publicDomain || typeof rawSecret !== 'string' || rawSecret.length < 16 || rawSecret.length > 1_024) throw new Error('系统操作字段无效');
      draft = { publicCallbackUrl, publicDomain, replacementSecret: rawSecret };
    }
    const result = await dependencies.port.executeSystemOperation({ ...requestBase, actorId: authorization.claims.subjectId,
      audit: { idempotencyKey: command.intentId, reason: command.reason }, confirmed: true,
      expectedVersion: command.expectedVersion, operation, preflightToken: command.preflightToken, resourceId,
      ...(draft ? { draft } : {}) });
    if (operation === 'REDRIVE_DLQ') {
      const queuePreview = preview as NonNullable<SystemSnapshot['queues'][number]['preview']>;
      const bound = exactRecord(result, ['auditRecordId', 'businessKey', 'currentOutcome', 'idempotencyKey', 'ok', 'operation', 'requestId', 'resourceId', 'version']);
      if (!bound || bound.ok !== true || !isUuidV7(bound.auditRecordId) || !isUuidV7(bound.requestId) ||
          bound.idempotencyKey !== command.intentId || bound.operation !== operation || bound.resourceId !== resourceId ||
          bound.version !== preview.resultVersion || bound.businessKey !== queuePreview.businessKey ||
          bound.currentOutcome !== queuePreview.currentOutcome) throw new Error('运营操作回执无效');
      return Object.freeze({ ...bound });
    }
    return parseReceipt(result, { idempotencyKey: command.intentId, operation, resourceId, resourceKey: 'resourceId',
      version: preview.resultVersion });
  };
}
