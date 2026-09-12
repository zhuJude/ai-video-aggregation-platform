import type { ReactNode } from 'react';

import { AppShell } from '../../components/app-shell';
import { readWorkspaceShellUser } from '../../lib/workspace-shell';

export default async function WorkspaceLayout({ children }: Readonly<{ children: ReactNode }>) {
  const user = await readWorkspaceShellUser();
  return <AppShell user={user}>{children}</AppShell>;
}
