export type DataScope = 'ALL' | 'OWN' | 'ASSIGNED';

export type AdminSubject = Readonly<{
  permissions: readonly string[];
  dataScope: DataScope;
}>;

export function hasPermission(
  subject: Pick<AdminSubject, 'permissions'>,
  requiredPermission: string,
): boolean {
  return (
    subject.permissions.includes('*') ||
    subject.permissions.includes(requiredPermission)
  );
}

export const dataScopeLabels: Readonly<Record<DataScope, string>> = {
  ALL: '全部',
  OWN: '本人负责',
  ASSIGNED: '已分配',
};
