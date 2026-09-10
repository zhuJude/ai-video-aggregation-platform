export type DataScope = 'ALL' | 'OWN' | 'ASSIGNED';

export const ADMIN_PERMISSIONS = [
  '*',
  'audit:read',
  'content:read',
  'finance:read',
  'iam:read',
  'models:read',
  'models:rollback',
  'models:publish',
  'models:write',
  'overview:read',
  'pricing:read',
  'credentials:disable',
  'credentials:read',
  'credentials:rotate',
  'providers:circuit-reset',
  'providers:disable',
  'providers:enable',
  'providers:probe',
  'providers:read',
  'providers:write',
  'routing:read',
  'system:read',
  'tasks:read',
  'tickets:read',
  'users:export',
  'users:phone-exact',
  'users:read',
  'users:refresh',
  'users:status',
  'wallet:adjust',
] as const;

export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];
export const ADMIN_PERMISSION_MAX_COUNT = ADMIN_PERMISSIONS.length;
export const ADMIN_PERMISSION_MAX_LENGTH = 32;
const ADMIN_PERMISSION_SET = new Set<string>(ADMIN_PERMISSIONS);

export function isValidAdminPermissions(value: unknown): value is readonly AdminPermission[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  if (value.length > ADMIN_PERMISSION_MAX_COUNT) return false;
  const unique = new Set<string>();
  for (const permission of value) {
    if (
      typeof permission !== 'string' ||
      permission.length === 0 ||
      permission.length > ADMIN_PERMISSION_MAX_LENGTH ||
      !ADMIN_PERMISSION_SET.has(permission) ||
      unique.has(permission)
    )
      return false;
    unique.add(permission);
  }
  return true;
}

export type AdminSubject = Readonly<{
  permissions: readonly string[];
  dataScope: DataScope;
}>;

export function hasPermission(
  subject: Pick<AdminSubject, 'permissions'>,
  requiredPermission: string,
): boolean {
  return subject.permissions.includes('*') || subject.permissions.includes(requiredPermission);
}

export const dataScopeLabels: Readonly<Record<DataScope, string>> = {
  ALL: '全部',
  OWN: '本人负责',
  ASSIGNED: '已分配',
};
