import type { UserDirectoryPort } from './http-user-operation-port';
import type { ServerGuardContext } from './server-guard';
import { requireAdminAuthorization } from './server-guard';
import { hasPermission } from './permissions';
import { createUuidV7, isUuidV7 } from './uuid-v7';
import { isMainlandPhone, isMaskedMainlandPhone } from './frozen-scalars';
import {
  createOutboundRequestContext,
  parseOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';
import { createTraceId } from './trace-id';
import {
  containsSensitivePhoneLikeValue,
  isSafeDirectoryCursor,
  REGISTRATION_SOURCES,
  SPENDING_TIERS,
  USER_STATUSES,
  type UserFilters,
} from './sensitive-query';
import {
  isValidExactPhoneDescriptorSigningKey,
  isValidExactPhoneUpstreamExpiry,
  isValidExactPhoneUpstreamHandle,
  sealExactPhoneSearchDescriptor,
} from './exact-phone-descriptor';
import { isPhoneFreeBoundedText } from './phone-free-egress';

export { REGISTRATION_SOURCES, SPENDING_TIERS, USER_STATUSES };
export type { UserFilters };
export type UserRow = Readonly<{
  id: string;
  displayName: string;
  phoneMasked: string;
  registrationSource?: string;
  spendingTier?: string;
  status: (typeof USER_STATUSES)[number];
  tags?: readonly string[];
}>;
type Dependencies = Readonly<{
  context?: ServerGuardContext;
  createRequestContext?: () => unknown;
  directoryPort: UserDirectoryPort;
}>;
const tagPattern = /^[\p{L}\p{N}_ -]{1,64}$/u;

export interface ExactPhoneLookupPort {
  lookupExactPhone(
    input: Readonly<{
      phone: string;
      requestContext?: OutboundRequestContext;
      scope: 'ALL' | 'ASSIGNED' | 'OWN';
      trustedSessionToken: string;
    }>,
  ): Promise<Readonly<{ expiresAt: string; items: readonly unknown[]; searchHandle: string }>>;
}

function isUserStatus(value: unknown): value is (typeof USER_STATUSES)[number] {
  return (
    typeof value === 'string' && USER_STATUSES.includes(value as (typeof USER_STATUSES)[number])
  );
}

export function validateUserFilters(
  value: Readonly<{
    registrationSource?: unknown;
    spendingTier?: unknown;
    status?: unknown;
    tag?: unknown;
  }>,
): UserFilters {
  const check = (candidate: unknown, allowed: readonly string[]) =>
    candidate === undefined || (typeof candidate === 'string' && allowed.includes(candidate));
  if (
    !check(value.status, USER_STATUSES) ||
    !check(value.registrationSource, REGISTRATION_SOURCES) ||
    !check(value.spendingTier, SPENDING_TIERS) ||
    (value.tag !== undefined && (typeof value.tag !== 'string' || !tagPattern.test(value.tag)))
  )
    throw new Error('筛选参数无效');
  return {
    ...(value.status ? { status: value.status as UserFilters['status'] } : {}),
    ...(value.tag ? { tag: value.tag } : {}),
    ...(value.registrationSource
      ? { registrationSource: value.registrationSource as UserFilters['registrationSource'] }
      : {}),
    ...(value.spendingTier
      ? { spendingTier: value.spendingTier as UserFilters['spendingTier'] }
      : {}),
  } as UserFilters;
}

export function validateUserRows(value: unknown): readonly UserRow[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('用户目录响应无效');
  return value.map((candidate) => {
    const row = candidate as Partial<UserRow>;
    if (
      !isUuidV7(row.id) ||
      !isPhoneFreeBoundedText(row.displayName, 256) ||
      !isMaskedMainlandPhone(row.phoneMasked) ||
      (candidate as { phone?: unknown }).phone !== undefined ||
      !isUserStatus(row.status) ||
      (row.registrationSource !== undefined &&
        !REGISTRATION_SOURCES.includes(row.registrationSource as never)) ||
      (row.spendingTier !== undefined && !SPENDING_TIERS.includes(row.spendingTier as never))
    )
      throw new Error('用户目录响应无效');
    if (
      row.tags !== undefined &&
      (!Array.isArray(row.tags) ||
        row.tags.length > 16 ||
        row.tags.some(
          (tag) =>
            typeof tag !== 'string' ||
            !tagPattern.test(tag) ||
            containsSensitivePhoneLikeValue(tag),
        ))
    )
      throw new Error('用户目录响应无效');
    return {
      id: row.id,
      displayName: row.displayName,
      phoneMasked: row.phoneMasked,
      status: row.status,
      ...(row.registrationSource ? { registrationSource: row.registrationSource } : {}),
      ...(row.spendingTier ? { spendingTier: row.spendingTier } : {}),
      ...(row.tags ? { tags: row.tags } : {}),
    };
  });
}

export function isValidSearchHandle(value: unknown): value is string {
  return isValidExactPhoneUpstreamHandle(value);
}

export function isValidShortLivedSearchExpiry(value: unknown, now = Date.now()): value is string {
  return isValidExactPhoneUpstreamExpiry(value, now);
}

function validateNextCursor(value: string | null): string | null {
  if (value === null) return null;
  if (!isSafeDirectoryCursor(value)) throw new Error('用户目录响应无效');
  return value;
}

export function createExactPhoneLookupAction({
  createCorrelationId = createUuidV7,
  createTraceId: makeTraceId = createTraceId,
  descriptorSigningKey = process.env.ADMIN_EXACT_PHONE_DESCRIPTOR_SIGNING_KEY,
  guardContext,
  now = Date.now,
  port,
}: Readonly<{
  createCorrelationId?: () => string;
  createTraceId?: () => string;
  descriptorSigningKey?: string | undefined;
  guardContext?: ServerGuardContext;
  now?: () => number;
  port: ExactPhoneLookupPort;
}>) {
  return async function exactPhoneLookupAction(
    formData: FormData,
  ): Promise<
    Readonly<{ expiresAt: string; items: readonly UserRow[]; ok: true; searchDescriptor: string }>
  > {
    const authorization = await requireAdminAuthorization('users:read', guardContext);
    await requireAdminAuthorization('users:phone-exact', guardContext);
    const phone = formData.get('phone');
    if (!isMainlandPhone(phone)) throw new Error('精确手机号格式无效');
    if (!isValidExactPhoneDescriptorSigningKey(descriptorSigningKey))
      throw new Error('搜索凭证签名配置无效');
    const requestContext = createOutboundRequestContext(makeTraceId, createCorrelationId);
    const result = await port.lookupExactPhone({
      phone,
      requestContext,
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    });
    const items = validateUserRows(result.items);
    const issuedAt = now();
    if (
      !isValidSearchHandle(result.searchHandle) ||
      !isValidShortLivedSearchExpiry(result.expiresAt, issuedAt)
    )
      throw new Error('精确手机号查询响应无效');
    const searchDescriptor = await sealExactPhoneSearchDescriptor(
      {
        expiresAt: result.expiresAt,
        handle: result.searchHandle,
        scope: authorization.claims.dataScope,
        sessionInstanceId: authorization.claims.sessionInstanceId,
        subjectId: authorization.claims.subjectId,
      },
      { now: () => issuedAt, signingKey: descriptorSigningKey },
    );
    return { expiresAt: result.expiresAt, items, ok: true, searchDescriptor };
  };
}

export async function loadUsersView(
  input: Readonly<{
    cursor?: string;
    filters?: Readonly<{
      registrationSource?: unknown;
      spendingTier?: unknown;
      status?: unknown;
      tag?: unknown;
    }>;
    query: string;
  }>,
  {
    context,
    createRequestContext: makeRequestContext = createOutboundRequestContext,
    directoryPort,
  }: Dependencies,
): Promise<
  Readonly<{
    canExport: boolean;
    canUseExactPhone: boolean;
    filters: UserFilters;
    items: readonly UserRow[];
    nextCursor: string | null;
  }>
> {
  if (
    [input.query, input.cursor, ...Object.values(input.filters ?? {})].some(
      containsSensitivePhoneLikeValue,
    )
  )
    throw new Error('敏感查询参数无效');
  const query = input.query.trim();
  if (query.length > 128 || (input.cursor !== undefined && !isSafeDirectoryCursor(input.cursor)))
    throw new Error('查询参数无效');
  if (isMainlandPhone(query)) throw new Error('手机号请使用受保护的精确查询');
  const filters = validateUserFilters(input.filters ?? {});
  const authorization = await requireAdminAuthorization('users:read', context);
  const canUseExactPhone = hasPermission(authorization.claims, 'users:phone-exact');
  const requestContext = parseOutboundRequestContext(makeRequestContext());
  const result = await directoryPort.searchUsers({
    ...(input.cursor ? { cursor: input.cursor } : {}),
    filters,
    query,
    requestContext,
    trustedSessionToken: authorization.trustedSessionToken,
  });
  const items = validateUserRows(result.items);
  return {
    canExport: hasPermission(authorization.claims, 'users:export'),
    canUseExactPhone,
    filters,
    items,
    nextCursor: validateNextCursor(result.nextCursor),
  };
}
