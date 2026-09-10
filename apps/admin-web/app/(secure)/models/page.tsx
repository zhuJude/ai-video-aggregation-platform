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

import { createHttpModelCapabilityPorts } from '../../../lib/http-model-capability-port';
import {
  loadModelDirectoryView,
  type ModelDirectoryPort,
} from '../../../lib/model-capability-operations';
import type { ServerGuardContext } from '../../../lib/server-guard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderModelsPage(
  dependencies: Readonly<{ context?: ServerGuardContext; port: ModelDirectoryPort }>,
) {
  const view = await loadModelDirectoryView(dependencies);
  return (
    <section aria-labelledby="models-heading">
      <Title2 as="h2" id="models-heading">
        模型能力目录
      </Title2>
      <Text>权威数据时间：{view.sourceUpdatedAt}</Text>
      {view.partialFields.length > 0 ? (
        <Text role="alert">
          部分字段暂不可用：{view.partialFields.join('、')}。页面不会推断缺失值。
        </Text>
      ) : null}
      {view.items.length === 0 ? (
        <Text>当前数据范围内暂无模型</Text>
      ) : (
        <Table aria-label="模型能力目录">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>模型</TableHeaderCell>
              <TableHeaderCell>供应商</TableHeaderCell>
              <TableHeaderCell>状态</TableHeaderCell>
              <TableHeaderCell>草稿</TableHeaderCell>
              <TableHeaderCell>已发布</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.items.map((model) => (
              <TableRow key={model.id}>
                <TableCell>
                  <Link href={`/models/${encodeURIComponent(model.id)}/capabilities`}>
                    {model.displayName}
                  </Link>
                  <br />
                  <Text size={200}>{model.code}</Text>
                </TableCell>
                <TableCell>{model.providerName}</TableCell>
                <TableCell>
                  <Badge appearance="outline">{model.status}</Badge>
                </TableCell>
                <TableCell>
                  {model.draftVersion === null ? '—' : `v${String(model.draftVersion)}`}
                </TableCell>
                <TableCell>
                  {model.publishedVersion === null ? '—' : `v${String(model.publishedVersion)}`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}

export default async function ModelsPage() {
  return renderModelsPage({ port: createHttpModelCapabilityPorts().directoryPort });
}
