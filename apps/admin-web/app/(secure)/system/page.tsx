import { SystemConsole } from '../../../components/governance/governance-console';
import { loadSystemSnapshot, type GovernanceOperationsPort } from '../../../lib/governance-operations';
import { createHttpGovernanceOperationsPort } from '../../../lib/http-governance-port';
import { requireAdminAuthorization, type ServerGuardContext } from '../../../lib/server-guard';
import { operateSystem } from '../governance-actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderSystemPage(dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>) {
  const [authorization, view] = await Promise.all([
    requireAdminAuthorization('system:read', dependencies.context), loadSystemSnapshot(dependencies),
  ]);
  return <SystemConsole onOperation={operateSystem} permissions={authorization.claims.permissions} view={view} />;
}

export default function SystemPage() {
  return renderSystemPage({ port: createHttpGovernanceOperationsPort() });
}
