export type DataScope = 'ALL' | 'OWN' | 'ASSIGNED';

export interface PermissionGrant {
  readonly permission: string;
  readonly dataScope: DataScope;
}

export interface AuthorizationSubject {
  readonly adminId: string;
  readonly grants: readonly PermissionGrant[];
}

export interface ResourceAuthorizationContext {
  readonly ownerAdminId?: string;
  readonly assignedAdminIds?: readonly string[];
}

const SCOPE_ORDER: readonly DataScope[] = ['OWN', 'ASSIGNED'];

export function mergeDataScopes(grants: unknown, permission: string): readonly DataScope[] {
  if (!Array.isArray(grants) || !validPermission(permission)) return [];
  const matching = new Set<DataScope>();
  for (const candidate of grants as readonly unknown[]) {
    if (isPermissionGrant(candidate) && candidate.permission === permission) {
      const grant = candidate;
      matching.add(grant.dataScope);
    }
  }
  if (matching.has('ALL')) return ['ALL'];
  return SCOPE_ORDER.filter((scope) => matching.has(scope));
}

export function can(
  subject: AuthorizationSubject | null | undefined,
  permission: string,
  resource: ResourceAuthorizationContext | null | undefined,
): boolean {
  if (
    !subject ||
    typeof subject.adminId !== 'string' ||
    subject.adminId.length === 0 ||
    !resource ||
    typeof resource !== 'object'
  ) {
    return false;
  }
  const scopes = mergeDataScopes(subject.grants, permission);
  if (scopes.includes('ALL')) return true;
  if (scopes.includes('OWN') && resource.ownerAdminId === subject.adminId) return true;
  return (
    scopes.includes('ASSIGNED') &&
    Array.isArray(resource.assignedAdminIds) &&
    resource.assignedAdminIds.includes(subject.adminId)
  );
}

function isPermissionGrant(value: unknown): value is PermissionGrant {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['permission'] === 'string' &&
    (candidate['dataScope'] === 'ALL' ||
      candidate['dataScope'] === 'OWN' ||
      candidate['dataScope'] === 'ASSIGNED')
  );
}

function validPermission(value: string): boolean {
  return /^[a-z][a-z0-9_.-]{0,63}(?::[a-z][a-z0-9_.-]{0,63})+$/.test(value);
}
