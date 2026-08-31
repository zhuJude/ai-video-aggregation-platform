import { cookies } from 'next/headers';

import { hasPermission } from './permissions';
import {
  ADMIN_SESSION_COOKIE,
  AuthorizationError,
  type AdminSessionClaims,
  verifyAdminSession,
} from './session-auth';

export type ServerGuardContext = Readonly<{
  sessionToken?: string | undefined;
  signingKey?: string | undefined;
}>;

export type ScopedResourceContext = Readonly<{
  ownerAdminId: string | null;
  assignedAdminIds: readonly string[];
}>;

export type AdminAuthorizationContext = Readonly<{
  claims: AdminSessionClaims;
  trustedSessionToken: string;
}>;

export async function requireAdminAuthorization(
  requiredPermission: string,
  context?: ServerGuardContext,
): Promise<AdminAuthorizationContext> {
  const cookieStore = context ? null : await cookies();
  const sessionToken = context
    ? context.sessionToken
    : cookieStore?.get(ADMIN_SESSION_COOKIE)?.value;
  const signingKey = context?.signingKey ?? process.env.ADMIN_SESSION_SIGNING_KEY;
  const claims = await verifyAdminSession(sessionToken, signingKey);

  if (!claims) {
    throw new AuthorizationError('UNAUTHENTICATED', '需要管理员登录');
  }

  if (!hasPermission(claims, requiredPermission)) {
    throw new AuthorizationError('FORBIDDEN', '权限不足');
  }

  return { claims, trustedSessionToken: sessionToken as string };
}

export async function requireAdminPermission(
  requiredPermission: string,
  context?: ServerGuardContext,
): Promise<AdminSessionClaims> {
  return (await requireAdminAuthorization(requiredPermission, context)).claims;
}

export function assertAdminDataScope(
  claims: AdminSessionClaims,
  resource: ScopedResourceContext | undefined,
): void {
  if (!resource) {
    throw new AuthorizationError('FORBIDDEN', '缺少数据范围上下文');
  }

  const allowed =
    claims.dataScope === 'ALL' ||
    (claims.dataScope === 'OWN' &&
      resource.ownerAdminId === claims.subjectId) ||
    (claims.dataScope === 'ASSIGNED' &&
      resource.assignedAdminIds.includes(claims.subjectId));
  if (!allowed) {
    throw new AuthorizationError('FORBIDDEN', '数据范围不允许此操作');
  }
}

export async function requireAdminScopedPermission(
  requiredPermission: string,
  resource: ScopedResourceContext | undefined,
  context?: ServerGuardContext,
): Promise<AdminSessionClaims> {
  const claims = await requireAdminPermission(requiredPermission, context);
  assertAdminDataScope(claims, resource);
  return claims;
}
