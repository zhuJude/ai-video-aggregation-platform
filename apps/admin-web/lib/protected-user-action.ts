import {
  type ScopedResourceContext,
  type ServerGuardContext,
  assertAdminDataScope,
  requireAdminAuthorization,
} from './server-guard';

export interface ResourceScopePort {
  getUserScope(userId: string): Promise<ScopedResourceContext>;
}

export interface UserOperationPort {
  refreshUser(input: Readonly<{
    userId: string;
    trustedSessionToken: string;
  }>): Promise<void>;
}

type RefreshUserActionDependencies = Readonly<{
  scopePort: ResourceScopePort;
  operationPort: UserOperationPort;
  guardContext?: ServerGuardContext;
}>;

export function createRefreshUserAction({
  guardContext,
  operationPort,
  scopePort,
}: RefreshUserActionDependencies) {
  return async function refreshUserAction(
    formData: FormData,
  ): Promise<Readonly<{ ok: true }>> {
    const authorization = await requireAdminAuthorization(
      'users:refresh',
      guardContext,
    );
    const submittedUserId = formData.get('userId');
    if (typeof submittedUserId !== 'string' || !submittedUserId.trim()) {
      throw new Error('缺少用户标识');
    }

    const userId = submittedUserId.trim();
    const resourceScope = await scopePort.getUserScope(userId);
    assertAdminDataScope(authorization.claims, resourceScope);
    await operationPort.refreshUser({
      userId,
      trustedSessionToken: authorization.trustedSessionToken,
    });
    return { ok: true };
  };
}
