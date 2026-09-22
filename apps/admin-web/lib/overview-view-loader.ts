import { requireAdminAuthorization, type ServerGuardContext } from './server-guard';
import {
  createOutboundRequestContext,
  parseOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';

export type OverviewSourceStatus = 'READY' | 'PARTIAL' | 'STALE' | 'EMPTY' | 'ERROR';

export type OverviewMoneyDirection = 'CREDIT' | 'DEBIT';

export type OverviewMeasure =
  | Readonly<{
      currency: 'CNY';
      direction?: OverviewMoneyDirection;
      id: string;
      label: string;
      minorUnits: string;
    }>
  | Readonly<{ id: 'average-generation-duration'; label: string; unit: 'SECONDS'; value: string }>
  | Readonly<{ id: string; label: string; value: string }>;

export type OverviewDataset = Readonly<{
  id: string;
  label: string;
  measures: readonly OverviewMeasure[];
  reason?: string;
  sourceTimestamp?: string;
  status: OverviewSourceStatus;
  warning?: string;
}>;

export type OverviewView = Readonly<{ datasets: readonly OverviewDataset[] }>;

export interface OverviewPort {
  getOverview(
    input: Readonly<{ requestContext: OutboundRequestContext; trustedSessionToken: string }>,
  ): Promise<OverviewView>;
}

export async function loadOverviewView(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    createRequestContext?: () => unknown;
    port: OverviewPort;
  }>,
): Promise<OverviewView> {
  const authorization = await requireAdminAuthorization('overview:read', dependencies.context);
  const requestContext = parseOutboundRequestContext(
    (dependencies.createRequestContext ?? createOutboundRequestContext)(),
  );
  return dependencies.port.getOverview({
    requestContext,
    trustedSessionToken: authorization.trustedSessionToken,
  });
}
