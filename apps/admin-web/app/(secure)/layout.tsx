import type { ReactNode } from 'react';

import { AdminShell } from '../../components/admin-shell';
import { requireAdminSession, type ServerGuardContext } from '../../lib/server-guard';

export async function renderSecureLayout(children: ReactNode, context?: ServerGuardContext) {
  const { claims } = await requireAdminSession(context);
  return (
    <AdminShell
      identity={claims.subjectId}
      subject={{ dataScope: claims.dataScope, permissions: claims.permissions }}
    >
      {children}
    </AdminShell>
  );
}

export default async function SecureLayout({ children }: Readonly<{ children: ReactNode }>) {
  return renderSecureLayout(children);
}
