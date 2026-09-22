export interface IdentityLockScope {
  readonly userId: string;
  readonly operationId?: string;
  readonly sessionFamilyId?: string;
}

export function identityLockKeys(scope: IdentityLockScope): readonly string[] {
  return [
    `identity-account:${scope.userId}`,
    ...(scope.operationId ? [`identity-operation:${scope.operationId}`] : []),
    ...(scope.sessionFamilyId
      ? [`identity-session-family:${scope.sessionFamilyId}`]
      : []),
  ].sort();
}
