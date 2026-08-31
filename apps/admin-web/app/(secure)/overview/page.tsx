import { OverviewCockpit } from '../../../components/overview-cockpit';
import { createHttpOverviewPort } from '../../../lib/http-overview-port';
import { loadOverviewView } from '../../../lib/overview-view-loader';

export const dynamic = 'force-dynamic';

export default async function OverviewPage() {
  const view = await loadOverviewView({ port: createHttpOverviewPort() });
  return <OverviewCockpit datasets={view.datasets} />;
}
