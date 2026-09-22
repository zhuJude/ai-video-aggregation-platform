import {
  type ScopedResourceContext,
  type ServerGuardContext,
  assertAdminDataScope,
  requireAdminAuthorization,
} from './server-guard';
import { createUuidV7, isUuidV7 } from './uuid-v7';
import { createTraceId } from './trace-id';
import { createOutboundRequestContext, type OutboundRequestContext } from './outbound-request-context';
import { containsSensitivePhoneLikeValue } from './sensitive-query';

export interface ResourceScopePort {
  getUserScope(input: Readonly<{ requestContext?: OutboundRequestContext; trustedSessionToken: string; userId: string }>): Promise<ScopedResourceContext>;
}

export interface UserStatusPort {
  requestStatusChange(input: Readonly<{ audit: Readonly<{ idempotencyKey: string }>; reason: string; requestContext?: OutboundRequestContext; targetStatus: 'ACTIVE' | 'SUSPENDED'; trustedSessionToken: string; userId: string }>): Promise<Readonly<{ auditRecordId: string; requestId: string }>>;
}

type UserStatusActionDependencies = Readonly<{ createCorrelationId?: () => string; createTraceId?: () => string; guardContext?: ServerGuardContext; port: UserStatusPort; scopePort: ResourceScopePort }>;
export function createUserStatusAction({ createCorrelationId: makeCorrelationId = createUuidV7, createTraceId: makeTraceId = createTraceId, guardContext, port, scopePort }: UserStatusActionDependencies) {
  return async function userStatusAction(formData: FormData): Promise<Readonly<{ auditRecordId: string; ok: true; requestId: string }>> {
    const authorization = await requireAdminAuthorization('users:status', guardContext);
    const userId = typeof formData.get('userId') === 'string' ? formData.get('userId') as string : '';
    const currentStatus = formData.get('currentStatus');
    const targetStatus = currentStatus === 'ACTIVE' ? 'SUSPENDED' : currentStatus === 'SUSPENDED' ? 'ACTIVE' : null;
    const reason = typeof formData.get('reason') === 'string' ? (formData.get('reason') as string).trim() : '';
    const intentId = formData.get('intentId');
    if (!isUuidV7(userId) || !isUuidV7(intentId) || !targetStatus || !reason || reason.length > 200 || containsSensitivePhoneLikeValue(reason) || formData.get('highRiskConfirmed') !== 'true') throw new Error('状态变更无效');
    const requestContext = createOutboundRequestContext(makeTraceId, makeCorrelationId);
    assertAdminDataScope(authorization.claims, await scopePort.getUserScope({ requestContext, trustedSessionToken: authorization.trustedSessionToken, userId }));
    const result = await port.requestStatusChange({ audit: { idempotencyKey: intentId }, reason, requestContext, targetStatus, trustedSessionToken: authorization.trustedSessionToken, userId });
    if (!isUuidV7(result.auditRecordId) || !isUuidV7(result.requestId)) throw new Error('状态变更响应无效');
    return { auditRecordId: result.auditRecordId, ok: true, requestId: result.requestId };
  };
}
