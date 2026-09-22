import {
  Badge,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
} from '@fluentui/react-components';

import { ProviderMetadataForm } from '../../../components/provider-metadata-form';
import { createHttpProviderOperationPorts } from '../../../lib/http-provider-operation-port';
import {
  loadProviderDirectoryView,
  type ProviderDirectoryPort,
} from '../../../lib/provider-operations';
import type { ServerGuardContext } from '../../../lib/server-guard';
import { writeProviderMetadataAction } from './actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type ProvidersPageDependencies = Readonly<{
  context?: ServerGuardContext;
  port: ProviderDirectoryPort;
}>;

export async function renderProvidersPage(dependencies: ProvidersPageDependencies) {
  const view = await loadProviderDirectoryView(dependencies);

  return (
    <section aria-labelledby="providers-heading">
      <Title2 as="h2" id="providers-heading">供应商运营</Title2>
      <Text>权威数据时间：{view.sourceUpdatedAt}</Text>
      {view.canCreate ? (
        <ProviderMetadataForm
          actorId={view.actorId}
          mode="CREATE"
          onSubmit={writeProviderMetadataAction}
        />
      ) : null}
      {view.partialFields.length > 0 ? (
        <Text role="alert">
          部分指标暂不可用：{view.partialFields.join('、')}。缺失值不会被推断或缓存替代。
        </Text>
      ) : null}
      {view.items.length === 0 ? <Text>暂无供应商</Text> : (
        <Table aria-label="供应商运营目录">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>供应商</TableHeaderCell>
              <TableHeaderCell>状态</TableHeaderCell>
              <TableHeaderCell>健康</TableHeaderCell>
              <TableHeaderCell>成功率</TableHeaderCell>
              <TableHeaderCell>P95 延迟</TableHeaderCell>
              <TableHeaderCell>熔断</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.items.map((provider) => (
              <TableRow key={provider.id}>
                <TableCell>
                  <Link href={`/providers/${encodeURIComponent(provider.id)}`}>{provider.name}</Link>
                </TableCell>
                <TableCell><Badge appearance="outline">{provider.status}</Badge></TableCell>
                <TableCell><Badge appearance="tint">{provider.health}</Badge></TableCell>
                <TableCell>{(provider.successRateBps / 100).toFixed(2)}%</TableCell>
                <TableCell>{provider.latencyP95Ms} ms</TableCell>
                <TableCell>{provider.circuitState}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

export default async function ProvidersPage() {
  return renderProvidersPage({ port: createHttpProviderOperationPorts().directoryPort });
}
