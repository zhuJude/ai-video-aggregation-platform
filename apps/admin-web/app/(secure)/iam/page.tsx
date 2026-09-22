import { IamConsole } from '../../../components/governance/governance-console';
import {
  loadIamDirectory,
  type GovernanceOperationsPort,
} from '../../../lib/governance-operations';
import { createHttpGovernanceOperationsPort } from '../../../lib/http-governance-port';
import { requireAdminAuthorization, type ServerGuardContext } from '../../../lib/server-guard';
import { updateAdmin, updateRole } from '../governance-actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderIamPage(
  dependencies: Readonly<{ context?: ServerGuardContext; port: GovernanceOperationsPort }>,
) {
  const [authorization, directory] = await Promise.all([
    requireAdminAuthorization('iam:read', dependencies.context),
    loadIamDirectory(dependencies),
  ]);
  return (
    <IamConsole
      actorPermissions={authorization.claims.permissions}
      directory={directory}
      onAdminUpdate={updateAdmin}
      onUpdate={updateRole}
    />
  );
}

export default function IamPage() {
  return renderIamPage({ port: createHttpGovernanceOperationsPort() });
}
