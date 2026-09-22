import { ProviderDetailConsole } from '../../../../components/provider-detail-console';
import { createHttpProviderOperationPorts } from '../../../../lib/http-provider-operation-port';
import {
  loadProviderDetailView,
  type ProviderDetailPort,
} from '../../../../lib/provider-operations';
import type { ServerGuardContext } from '../../../../lib/server-guard';
import { executeProviderCommandAction, writeProviderMetadataAction } from '../actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type ProviderDetailDependencies = Readonly<{
  context?: ServerGuardContext;
  port: ProviderDetailPort;
}>;

export async function renderProviderDetailRoute(
  providerId: string,
  dependencies: ProviderDetailDependencies,
) {
  const view = await loadProviderDetailView(providerId, dependencies);
  return (
    <ProviderDetailConsole
      onCommand={executeProviderCommandAction}
      onMetadataSubmit={writeProviderMetadataAction}
      permissions={view.permissions}
      provider={view.provider}
    />
  );
}

export default async function ProviderDetailPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return renderProviderDetailRoute(id, { port: createHttpProviderOperationPorts().detailPort });
}
