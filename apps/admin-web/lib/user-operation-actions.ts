import type { ResourceScopePort } from './protected-user-action';
import {
  type ServerGuardContext,
  assertAdminDataScope,
  requireAdminAuthorization,
} from './server-guard';
import { validateUserFilters, type UserFilters } from './user-view-loaders';
import { createUuidV7, isSameUuidV7, isUuidV7 } from './uuid-v7';
import { createTraceId } from './trace-id';
import {
  isCoherentPointsAdjustment,
  isMainlandPhone,
  isPointsString,
  isUtcIso8601Z,
} from './frozen-scalars';
import {
  createOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';
import { containsSensitivePhoneLikeValue } from './sensitive-query';
import { isPhoneFreeBoundedText, isPhoneFreeHttpsUrl } from './phone-free-egress';
import { verifyExactPhoneSearchDescriptor } from './exact-phone-descriptor';

export type WalletAdjustmentDirection = 'CREDIT' | 'DEBIT';

export interface WalletAdjustmentRequestPort {
  approveAdjustment?(
    input: Readonly<{
      audit: Readonly<{ idempotencyKey: string }>;
      expectedVersion: number;
      preflightToken: string;
      reason: string;
      requestContext?: OutboundRequestContext;
      requestId: string;
      trustedSessionToken: string;
      userId: string;
    }>,
  ): Promise<WalletAdjustmentApprovalReceipt>;
  getAdjustmentRequest?(
    input: Readonly<{
      requestContext?: OutboundRequestContext;
      requestId: string;
      trustedSessionToken: string;
      userId: string;
    }>,
  ): Promise<WalletAdjustmentApprovalRequest>;
  getEligibleApprovers(
    input: Readonly<{
      dataScope: 'ALL' | 'ASSIGNED' | 'OWN';
      requestContext?: OutboundRequestContext;
      trustedSessionToken: string;
      userId: string;
    }>,
  ): Promise<readonly Readonly<{ displayName: string; id: string }>[]>;
  previewAdjustment?(
    input: Readonly<{
      approverId: string;
      audit: Readonly<{ idempotencyKey: string }>;
      direction: WalletAdjustmentDirection;
      points: bigint;
      reason: string;
      requestContext?: OutboundRequestContext;
      trustedSessionToken: string;
      userId: string;
    }>,
  ): Promise<WalletAdjustmentPreview>;
  previewApproval?(
    input: Readonly<{
      audit: Readonly<{ idempotencyKey: string }>;
      expectedVersion: number;
      reason: string;
      requestContext?: OutboundRequestContext;
      requestId: string;
      trustedSessionToken: string;
      userId: string;
    }>,
  ): Promise<WalletAdjustmentApprovalPreview>;
  submitAdjustmentRequest(
    input: Readonly<{
      approverId: string;
      audit: Readonly<{ idempotencyKey: string }>;
      direction: WalletAdjustmentDirection;
      points: bigint;
      reason: string;
      previewToken: string;
      requestContext?: OutboundRequestContext;
      trustedSessionToken: string;
      userId: string;
    }>,
  ): Promise<Readonly<{ auditRecordId: string; requestId: string; status: 'PENDING_APPROVAL' }>>;
}

export type WalletAdjustmentPreview = Readonly<{
  after: string;
  before: string;
  direction: WalletAdjustmentDirection;
  expiresAt: string;
  impact: string;
  points: string;
  policy: string;
  previewToken: string;
}>;
export type WalletAdjustmentApprovalRequest = Readonly<{
  approverId: string;
  direction: WalletAdjustmentDirection;
  id: string;
  points: string;
  requestedById: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  userId: string;
  version: number;
}>;
export type WalletAdjustmentApprovalPreview = Readonly<{
  expiresAt: string;
  impact: string;
  preflightToken: string;
  resultStatus: 'APPROVED';
  resultVersion: number;
}>;
export type WalletAdjustmentApprovalReceipt = Readonly<{
  auditRecordId: string;
  requestId: string;
  status: 'APPROVED';
  userId: string;
  version: number;
}>;

export interface UserExportPort {
  requestCsvExport(
    input: Readonly<{
      audit: Readonly<{ idempotencyKey: string }>;
      filters?: UserFilters;
      query?: string;
      reason: string;
      requestContext?: OutboundRequestContext;
      searchHandle?: string;
      scope: 'ALL' | 'ASSIGNED' | 'OWN';
      trustedSessionToken: string;
    }>,
  ): Promise<Readonly<{ auditRecordId: string; downloadUrl: string; expiresAt: string }>>;
}

type WalletAdjustmentActionDependencies = Readonly<{
  adjustmentPort: WalletAdjustmentRequestPort;
  createCorrelationId?: () => string;
  createTraceId?: () => string;
  guardContext?: ServerGuardContext;
  scopePort: ResourceScopePort;
}>;

type UserCsvExportActionDependencies = Readonly<{
  createCorrelationId?: () => string;
  createTraceId?: () => string;
  exportPort: UserExportPort;
  guardContext?: ServerGuardContext;
  descriptorSigningKey?: string | undefined;
  now?: () => number;
}>;

const PREVIEW_TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
const MAX_DESCRIPTOR_MS = 15 * 60_000;

function requiredVersion(formData: FormData): number {
  const value = requiredRawString(formData, 'expectedVersion', 16);
  if (!/^[1-9]\d{0,9}$/u.test(value)) throw new Error('审批版本无效');
  return Number(value);
}

function assertAuthoritativeApprovalRequest(
  request: WalletAdjustmentApprovalRequest,
  input: Readonly<{ actorId: string; expectedVersion: number; requestId: string; userId: string }>,
): void {
  const direction: unknown = request.direction;
  if (
    !isUuidV7(request.id) ||
    !isSameUuidV7(request.id, input.requestId) ||
    !isUuidV7(request.userId) ||
    !isSameUuidV7(request.userId, input.userId) ||
    !isUuidV7(request.requestedById) ||
    !isUuidV7(request.approverId) ||
    !isPointsString(request.points) ||
    request.points === '0' ||
    (direction !== 'CREDIT' && direction !== 'DEBIT') ||
    !Number.isSafeInteger(request.version) ||
    request.version < 1
  )
    throw new Error('点数调整申请响应无效');
  if (isSameUuidV7(request.requestedById, input.actorId)) throw new Error('禁止申请人自审');
  if (!isSameUuidV7(request.approverId, input.actorId)) throw new Error('非指定复核人');
  if (request.status !== 'PENDING_APPROVAL') throw new Error('申请已不再待审批');
  if (request.version !== input.expectedVersion) throw new Error('审批版本已变化');
}

function assertAuthoritativeApprovalPreview(
  preview: WalletAdjustmentApprovalPreview,
  expectedVersion: number,
): void {
  const expiresAt = Date.parse(preview.expiresAt);
  const now = Date.now();
  const resultStatus: unknown = preview.resultStatus;
  if (
    !PREVIEW_TOKEN.test(preview.preflightToken) ||
    !isUtcIso8601Z(preview.expiresAt) ||
    expiresAt <= now ||
    expiresAt > now + MAX_DESCRIPTOR_MS ||
    !isPhoneFreeBoundedText(preview.impact, 256) ||
    resultStatus !== 'APPROVED' ||
    preview.resultVersion !== expectedVersion + 1
  )
    throw new Error('审批预检响应无效');
}

export function createWalletAdjustmentApprovalPreviewAction({
  adjustmentPort,
  createCorrelationId: makeCorrelationId = createUuidV7,
  createTraceId: makeTraceId = createTraceId,
  guardContext,
  scopePort,
}: WalletAdjustmentActionDependencies) {
  return async function walletAdjustmentApprovalPreviewAction(
    formData: FormData,
  ): Promise<WalletAdjustmentApprovalPreview> {
    const authorization = await requireAdminAuthorization('wallet:adjust', guardContext);
    const userId = requiredRawString(formData, 'userId', 128);
    const requestId = requiredRawString(formData, 'requestId', 128);
    if (!isUuidV7(userId) || !isUuidV7(requestId)) throw new Error('审批对象无效');
    const expectedVersion = requiredVersion(formData);
    const reason = requiredTrimmedText(formData, 'reason', 200);
    const previewIntentId = requiredIntent(formData, 'previewIntentId', '审批预览审计上下文无效');
    if (!adjustmentPort.getAdjustmentRequest || !adjustmentPort.previewApproval)
      throw new Error('点数审批服务不可用');
    const requestContext = createOutboundRequestContext(makeTraceId, makeCorrelationId);
    assertAdminDataScope(
      authorization.claims,
      await scopePort.getUserScope({
        requestContext,
        trustedSessionToken: authorization.trustedSessionToken,
        userId,
      }),
    );
    const authoritative = await adjustmentPort.getAdjustmentRequest({
      requestContext,
      requestId,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    assertAuthoritativeApprovalRequest(authoritative, {
      actorId: authorization.claims.subjectId,
      expectedVersion,
      requestId,
      userId,
    });
    const preview = await adjustmentPort.previewApproval({
      audit: { idempotencyKey: previewIntentId },
      expectedVersion,
      reason,
      requestContext,
      requestId,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    assertAuthoritativeApprovalPreview(preview, expectedVersion);
    return preview;
  };
}

export function createWalletAdjustmentApprovalAction({
  adjustmentPort,
  createCorrelationId: makeCorrelationId = createUuidV7,
  createTraceId: makeTraceId = createTraceId,
  guardContext,
  scopePort,
}: WalletAdjustmentActionDependencies) {
  return async function walletAdjustmentApprovalAction(
    formData: FormData,
  ): Promise<WalletAdjustmentApprovalReceipt & Readonly<{ ok: true }>> {
    const authorization = await requireAdminAuthorization('wallet:adjust', guardContext);
    const userId = requiredRawString(formData, 'userId', 128);
    const requestId = requiredRawString(formData, 'requestId', 128);
    if (!isUuidV7(userId) || !isUuidV7(requestId)) throw new Error('审批对象无效');
    const expectedVersion = requiredVersion(formData);
    const reason = requiredTrimmedText(formData, 'reason', 200);
    if (formData.get('highRiskConfirmed') !== 'true') throw new Error('请确认点数调整审批');
    const displayedPreflightToken = requiredRawString(formData, 'preflightToken', 512);
    if (
      !PREVIEW_TOKEN.test(displayedPreflightToken) ||
      containsSensitivePhoneLikeValue(displayedPreflightToken)
    )
      throw new Error('审批预检凭证无效');
    const previewIntentId = requiredIntent(formData, 'previewIntentId', '审批预览审计上下文无效');
    const intentId = requiredIntent(formData, 'intentId', '审批审计上下文无效');
    if (
      !adjustmentPort.getAdjustmentRequest ||
      !adjustmentPort.previewApproval ||
      !adjustmentPort.approveAdjustment
    )
      throw new Error('点数审批服务不可用');
    const requestContext = createOutboundRequestContext(makeTraceId, makeCorrelationId);
    assertAdminDataScope(
      authorization.claims,
      await scopePort.getUserScope({
        requestContext,
        trustedSessionToken: authorization.trustedSessionToken,
        userId,
      }),
    );
    const authoritative = await adjustmentPort.getAdjustmentRequest({
      requestContext,
      requestId,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    assertAuthoritativeApprovalRequest(authoritative, {
      actorId: authorization.claims.subjectId,
      expectedVersion,
      requestId,
      userId,
    });
    const authoritativePreview = await adjustmentPort.previewApproval({
      audit: { idempotencyKey: previewIntentId },
      expectedVersion,
      reason,
      requestContext,
      requestId,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    assertAuthoritativeApprovalPreview(authoritativePreview, expectedVersion);
    if (authoritativePreview.preflightToken !== displayedPreflightToken)
      throw new Error('审批预检已变化');
    const result = await adjustmentPort.approveAdjustment({
      audit: { idempotencyKey: intentId },
      expectedVersion,
      preflightToken: authoritativePreview.preflightToken,
      reason,
      requestContext,
      requestId,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    const resultStatus: unknown = result.status;
    if (
      !isUuidV7(result.auditRecordId) ||
      !isSameUuidV7(result.requestId, requestId) ||
      !isSameUuidV7(result.userId, userId) ||
      resultStatus !== 'APPROVED' ||
      result.version !== expectedVersion + 1
    )
      throw new Error('点数审批回执无效');
    return { ...result, ok: true };
  };
}

async function requireEligibleApprover(
  port: WalletAdjustmentRequestPort,
  authorization: Awaited<ReturnType<typeof requireAdminAuthorization>>,
  requestContext: OutboundRequestContext,
  userId: string,
  approverId: string,
): Promise<void> {
  if (!isUuidV7(approverId) || isSameUuidV7(approverId, authorization.claims.subjectId))
    throw new Error('复核人无效');
  const response: unknown = await port.getEligibleApprovers({
    dataScope: authorization.claims.dataScope,
    requestContext,
    trustedSessionToken: authorization.trustedSessionToken,
    userId,
  });
  if (!Array.isArray(response) || response.length > 100) throw new Error('复核人无效');
  const approvers = response as readonly unknown[];
  const valid = approvers.every(
    (candidate): candidate is Readonly<{ displayName: string; id: string }> => {
      if (!candidate || typeof candidate !== 'object') return false;
      const approver = candidate as Record<string, unknown>;
      return isUuidV7(approver.id) && isPhoneFreeBoundedText(approver.displayName, 256);
    },
  );
  if (!valid || !approvers.some((approver) => isSameUuidV7(approver.id, approverId)))
    throw new Error('复核人无效');
}

function requiredTrimmedText(formData: FormData, name: string, maximumLength: number): string {
  const value = formData.get(name);
  if (typeof value !== 'string') {
    throw new Error(`缺少${name}`);
  }
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximumLength ||
    containsSensitivePhoneLikeValue(normalized)
  ) {
    throw new Error(`${name}无效`);
  }
  return normalized;
}

function requiredRawString(formData: FormData, name: string, maximumLength: number): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || !value || value.length > maximumLength)
    throw new Error(`${name}无效`);
  return value;
}

function parsePositivePoints(value: string): bigint {
  if (!isPointsString(value) || value === '0') throw new Error('调整点数格式无效');
  return BigInt(value);
}

function requiredPoints(formData: FormData): Readonly<{ points: bigint; text: string }> {
  const value = formData.get('points');
  if (typeof value !== 'string' || value.length > 128) throw new Error('调整点数格式无效');
  return { points: parsePositivePoints(value), text: value };
}

function requiredDirection(formData: FormData): WalletAdjustmentDirection {
  const direction = formData.get('direction');
  if (direction !== 'CREDIT' && direction !== 'DEBIT') throw new Error('调整方向无效');
  return direction;
}

function requiredIntent(formData: FormData, name: string, errorMessage: string): string {
  const value = formData.get(name);
  if (typeof value !== 'string' || value.length !== 36 || !isUuidV7(value))
    throw new Error(errorMessage);
  return value;
}

export function createWalletAdjustmentRequestAction({
  adjustmentPort,
  createCorrelationId: makeCorrelationId = createUuidV7,
  createTraceId: makeTraceId = createTraceId,
  guardContext,
  scopePort,
}: WalletAdjustmentActionDependencies) {
  return async function walletAdjustmentRequestAction(
    formData: FormData,
  ): Promise<
    Readonly<{ auditRecordId: string; ok: true; requestId: string; status: 'PENDING_APPROVAL' }>
  > {
    const authorization = await requireAdminAuthorization('wallet:adjust', guardContext);
    const userId = requiredRawString(formData, 'userId', 128);
    if (!isUuidV7(userId)) {
      throw new Error('用户标识无效');
    }
    const reason = requiredTrimmedText(formData, 'reason', 200);
    const approverId = requiredRawString(formData, 'approverId', 128);
    if (!isUuidV7(approverId)) throw new Error('复核人无效');
    if (formData.get('highRiskConfirmed') !== 'true') {
      throw new Error('请确认该申请将进入双人审批流程');
    }
    const direction = requiredDirection(formData);
    const { points } = requiredPoints(formData);
    const previewToken = requiredRawString(formData, 'previewToken', 512);
    if (!PREVIEW_TOKEN.test(previewToken) || containsSensitivePhoneLikeValue(previewToken))
      throw new Error('preview 凭证无效');
    const intentId = requiredIntent(formData, 'intentId', '审计上下文无效');
    const requestContext = createOutboundRequestContext(makeTraceId, makeCorrelationId);
    const resourceScope = await scopePort.getUserScope({
      requestContext,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    assertAdminDataScope(authorization.claims, resourceScope);
    await requireEligibleApprover(
      adjustmentPort,
      authorization,
      requestContext,
      userId,
      approverId,
    );
    const result = await adjustmentPort.submitAdjustmentRequest({
      approverId,
      audit: { idempotencyKey: intentId },
      direction,
      points,
      reason,
      previewToken,
      requestContext,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    if (!isUuidV7(result.requestId) || !isUuidV7(result.auditRecordId))
      throw new Error('调整申请响应无效');
    return {
      auditRecordId: result.auditRecordId,
      ok: true,
      requestId: result.requestId,
      status: result.status,
    };
  };
}

export function createWalletAdjustmentPreviewAction({
  adjustmentPort,
  createCorrelationId: makeCorrelationId = createUuidV7,
  createTraceId: makeTraceId = createTraceId,
  guardContext,
  scopePort,
}: WalletAdjustmentActionDependencies) {
  return async function walletAdjustmentPreviewAction(
    formData: FormData,
  ): Promise<WalletAdjustmentPreview> {
    const authorization = await requireAdminAuthorization('wallet:adjust', guardContext);
    const userId = requiredRawString(formData, 'userId', 128);
    if (!isUuidV7(userId)) throw new Error('用户标识无效');
    const reason = requiredTrimmedText(formData, 'reason', 200);
    const approverId = requiredRawString(formData, 'approverId', 128);
    if (!isUuidV7(approverId)) throw new Error('复核人无效');
    if (!adjustmentPort.previewAdjustment) throw new Error('调整预览服务不可用');
    const direction = requiredDirection(formData);
    const { points, text: pointsText } = requiredPoints(formData);
    const previewIntentId = requiredIntent(formData, 'previewIntentId', '预览审计上下文无效');
    const requestContext = createOutboundRequestContext(makeTraceId, makeCorrelationId);
    assertAdminDataScope(
      authorization.claims,
      await scopePort.getUserScope({
        requestContext,
        trustedSessionToken: authorization.trustedSessionToken,
        userId,
      }),
    );
    await requireEligibleApprover(
      adjustmentPort,
      authorization,
      requestContext,
      userId,
      approverId,
    );
    const preview = await adjustmentPort.previewAdjustment({
      approverId,
      audit: { idempotencyKey: previewIntentId },
      direction,
      points,
      reason,
      requestContext,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    const expiresAt = Date.parse(preview.expiresAt);
    if (
      !PREVIEW_TOKEN.test(preview.previewToken) ||
      containsSensitivePhoneLikeValue(preview.previewToken) ||
      !isUtcIso8601Z(preview.expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + MAX_DESCRIPTOR_MS ||
      !isPointsString(preview.before) ||
      !isPointsString(preview.after) ||
      !isPointsString(preview.points) ||
      preview.points !== pointsText ||
      preview.direction !== direction ||
      !isCoherentPointsAdjustment(
        preview.before,
        preview.after,
        preview.points,
        preview.direction,
      ) ||
      ![preview.impact, preview.policy].every((value) => isPhoneFreeBoundedText(value, 256))
    )
      throw new Error('调整预览无效');
    return preview;
  };
}

export function createUserCsvExportAction({
  createCorrelationId: makeCorrelationId = createUuidV7,
  createTraceId: makeTraceId = createTraceId,
  exportPort,
  guardContext,
  descriptorSigningKey = process.env.ADMIN_EXACT_PHONE_DESCRIPTOR_SIGNING_KEY,
  now = Date.now,
}: UserCsvExportActionDependencies) {
  return async function userCsvExportAction(
    formData: FormData,
  ): Promise<
    Readonly<{ auditRecordId: string; downloadUrl: string; expiresAt: string; ok: true }>
  > {
    const authorization = await requireAdminAuthorization('users:export', guardContext);
    const reason = requiredTrimmedText(formData, 'reason', 200);
    if (formData.get('highRiskConfirmed') !== 'true') throw new Error('请确认高风险导出');
    const submittedQuery = formData.get('query');
    if (
      submittedQuery !== null &&
      (typeof submittedQuery !== 'string' || submittedQuery.length > 128)
    ) {
      throw new Error('查询条件无效');
    }
    if (
      formData.get('exactPhone') !== null ||
      formData.get('phone') !== null ||
      formData.get('searchHandle') !== null ||
      formData.get('searchHandleExpiresAt') !== null
    )
      throw new Error('精确手机号模式无效');
    if (
      [
        submittedQuery,
        ...['status', 'tag', 'registrationSource', 'spendingTier'].map((name) =>
          formData.get(name),
        ),
      ].some(containsSensitivePhoneLikeValue)
    )
      throw new Error('敏感查询参数无效');
    const submittedSearchDescriptor = formData.get('searchDescriptor');
    const usesSearchDescriptor = submittedSearchDescriptor !== null;
    let verifiedSearchHandle: string | undefined;
    if (usesSearchDescriptor) {
      await requireAdminAuthorization('users:phone-exact', guardContext);
      if (
        submittedQuery !== null ||
        ['status', 'tag', 'registrationSource', 'spendingTier'].some(
          (name) => formData.get(name) !== null,
        )
      )
        throw new Error('搜索句柄不可与普通查询条件混用');
      const verified = await verifyExactPhoneSearchDescriptor(submittedSearchDescriptor, {
        now,
        scope: authorization.claims.dataScope,
        sessionInstanceId: authorization.claims.sessionInstanceId,
        signingKey: descriptorSigningKey,
        subjectId: authorization.claims.subjectId,
      });
      verifiedSearchHandle = verified.handle;
    }
    const intentId = requiredIntent(formData, 'intentId', '业务意图无效');
    const filters = usesSearchDescriptor
      ? undefined
      : validateUserFilters({
          status: formData.get('status') ?? undefined,
          tag: formData.get('tag') ?? undefined,
          registrationSource: formData.get('registrationSource') ?? undefined,
          spendingTier: formData.get('spendingTier') ?? undefined,
        });
    const query =
      typeof submittedQuery === 'string' ? submittedQuery.trim() || undefined : undefined;
    if (query && isMainlandPhone(query)) throw new Error('手机号请使用受保护的精确查询');
    const requestContext = createOutboundRequestContext(makeTraceId, makeCorrelationId);
    const result = await exportPort.requestCsvExport({
      audit: { idempotencyKey: intentId },
      ...(filters ? { filters } : {}),
      ...(!usesSearchDescriptor && query ? { query } : {}),
      reason,
      requestContext,
      ...(verifiedSearchHandle ? { searchHandle: verifiedSearchHandle } : {}),
      scope: authorization.claims.dataScope,
      trustedSessionToken: authorization.trustedSessionToken,
    });
    const expiresAt = Date.parse(result.expiresAt);
    if (
      !isUuidV7(result.auditRecordId) ||
      !isPhoneFreeHttpsUrl(result.downloadUrl) ||
      !isUtcIso8601Z(result.expiresAt) ||
      expiresAt <= Date.now() ||
      expiresAt > Date.now() + MAX_DESCRIPTOR_MS
    )
      throw new Error('导出下载凭证无效');
    return {
      auditRecordId: result.auditRecordId,
      downloadUrl: result.downloadUrl,
      expiresAt: result.expiresAt,
      ok: true,
    };
  };
}
