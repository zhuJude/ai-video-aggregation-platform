import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
} from '@fluentui/react-components';
import { PricingEditor } from '../../../components/operations/pricing-editor';
import { createHttpOperationsPorts } from '../../../lib/http-operations-port';
import { loadPricingView, type PricingOperationsPort } from '../../../lib/operations-server';
import type { ServerGuardContext } from '../../../lib/server-guard';
import { requireAdminAuthorization } from '../../../lib/server-guard';
import { hasPermission } from '../../../lib/permissions';
import { createUuidV7 } from '../../../lib/uuid-v7';
import {
  previewPricingAction,
  publishPricingAction,
  rollbackPricingAction,
  savePricingAction,
} from './actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export async function renderPricingPage(
  dependencies: Readonly<{ context?: ServerGuardContext; port: PricingOperationsPort }>,
) {
  const [view, auth] = await Promise.all([
    loadPricingView(dependencies),
    requireAdminAuthorization('pricing:read', dependencies.context),
  ]);
  return (
    <section aria-labelledby="pricing-heading">
      <Title2 as="h2" id="pricing-heading">
        版本化定价控制台
      </Title2>
      <Text>所有点数以十进制字符串传输和计算；浏览器预览不构成发布依据。</Text>
      <br />
      <Badge appearance="outline">权威数据 {view.sourceUpdatedAt}</Badge>
      <PricingEditor
        {...view}
        onPreview={previewPricingAction}
        onPublish={publishPricingAction}
        onSave={savePricingAction}
        permissions={auth.claims.permissions}
      />
      <Table aria-label="定价版本历史">
        <TableHeader>
          <TableRow>
            <TableHeaderCell>版本</TableHeaderCell>
            <TableHeaderCell>状态</TableHeaderCell>
            <TableHeaderCell>生效时间</TableHeaderCell>
            <TableHeaderCell>操作</TableHeaderCell>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.versions.map((version) => (
            <TableRow key={version.versionId}>
              <TableCell>v{String(version.version)}</TableCell>
              <TableCell>{version.status}</TableCell>
              <TableCell>{version.effectiveAt}</TableCell>
              <TableCell>
                {hasPermission(auth.claims, 'pricing:rollback') && version.status !== 'DRAFT' ? (
                  <form action={rollbackPricingAction}>
                    <input name="versionId" type="hidden" value={view.versionId} />
                    <input name="targetVersionId" type="hidden" value={version.versionId} />
                    <input name="expectedVersion" type="hidden" value={String(view.version)} />
                    <input name="intentId" type="hidden" value={createUuidV7()} />
                    <Field label="回滚原因">
                      <Input name="reason" />
                    </Field>
                    <Checkbox label="确认创建回滚版本" name="confirmed" value="true" />
                    <Button type="submit">回滚到此版本</Button>
                  </form>
                ) : (
                  '—'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}
export default function PricingPage() {
  return renderPricingPage({ port: createHttpOperationsPorts().pricing });
}
