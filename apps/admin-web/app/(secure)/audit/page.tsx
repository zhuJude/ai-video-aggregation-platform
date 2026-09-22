import { AuditConsole } from '../../../components/governance/governance-console';
import {
  loadAuditDirectory,
  type GovernanceOperationsPort,
} from '../../../lib/governance-operations';
import { createHttpGovernanceOperationsPort } from '../../../lib/http-governance-port';
import { requireAdminAuthorization, type ServerGuardContext } from '../../../lib/server-guard';
import { exportAudit } from '../governance-actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Filters = {
  action?: string;
  actor?: string;
  cursor?: string;
  from?: string;
  resource?: string;
  to?: string;
  traceId?: string;
};

export async function renderAuditPage(
  dependencies: Filters &
    Readonly<{
      context?: ServerGuardContext;
      port: GovernanceOperationsPort;
    }>,
) {
  const [authorization, view] = await Promise.all([
    requireAdminAuthorization('audit:read', dependencies.context),
    loadAuditDirectory(dependencies),
  ]);
  return (
    <AuditConsole
      onExport={exportAudit}
      permissions={authorization.claims.permissions}
      view={view}
    />
  );
}

export default async function AuditPage({
  searchParams,
}: Readonly<{ searchParams: Promise<Filters> }>) {
  return renderAuditPage({ ...(await searchParams), port: createHttpGovernanceOperationsPort() });
}
