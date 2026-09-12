import {
  Button,
  Checkbox,
  Field,
  Input,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Textarea,
  Title2,
} from '@fluentui/react-components';
import { RoutingSimulator } from '../../../components/operations/routing-simulator';
import { createHttpOperationsPorts } from '../../../lib/http-operations-port';
import { loadRoutingView } from '../../../lib/operations-server';
import { hasPermission } from '../../../lib/permissions';
import { requireAdminAuthorization } from '../../../lib/server-guard';
import { createUuidV7 } from '../../../lib/uuid-v7';
import {
  publishRoutingAction,
  previewRoutingAction,
  rollbackRoutingAction,
  saveRoutingAction,
  simulateRoutingAction,
} from './actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export default async function RoutingPage() {
  const ports = createHttpOperationsPorts();
  const [auth, view] = await Promise.all([
    requireAdminAuthorization('routing:read'),
    loadRoutingView({ port: ports.routing }),
  ]);
  const canMutateGlobalConfiguration = auth.claims.dataScope === 'ALL';
  return (
    <section aria-labelledby="routing-heading">
      <Title2 as="h2" id="routing-heading">
        路由策略与权威模拟
      </Title2>
      <Text>模拟结果展示候选、排除条件、分项评分、毛利风险和最终选择，不会直接改变生产路由。</Text>
      {canMutateGlobalConfiguration &&
      hasPermission(auth.claims, 'routing:write') &&
      view.status === 'DRAFT' ? (
        <form action={saveRoutingAction} aria-label="路由草稿编辑">
          <input name="versionId" type="hidden" value={view.versionId} />
          <input name="expectedVersion" type="hidden" value={String(view.version)} />
          <input name="intentId" type="hidden" value={createUuidV7()} />
          <Field label="质量权重">
            <Input defaultValue={String(view.qualityWeight)} name="qualityWeight" type="number" />
          </Field>
          <Field label="速度权重">
            <Input defaultValue={String(view.speedWeight)} name="speedWeight" type="number" />
          </Field>
          <Field label="价格权重">
            <Input defaultValue={String(view.priceWeight)} name="priceWeight" type="number" />
          </Field>
          <Field label="最低毛利 BPS">
            <Input
              defaultValue={String(view.minimumMarginBps)}
              name="minimumMarginBps"
              type="number"
            />
          </Field>
          <Field label="故障切换策略">
            <Select defaultValue={view.failoverMode} name="failoverMode">
              <option value="DISABLED">禁用</option>
              <option value="SMART_ONLY">仅智能模式</option>
              <option value="USER_OPT_IN">用户明确允许</option>
            </Select>
          </Field>
          <Field label="供应商优先级 JSON">
            <Textarea
              defaultValue={view.providerPriorityJson}
              name="providerPriorityJson"
              resize="vertical"
            />
          </Field>
          <Field label="能力备援映射 JSON">
            <Textarea
              defaultValue={view.backupCapabilityMapJson}
              name="backupCapabilityMapJson"
              resize="vertical"
            />
          </Field>
          <Field label="生效时间 UTC">
            <Input defaultValue={view.effectiveAt} name="effectiveAt" />
          </Field>
          <Field label="变更原因">
            <Input name="reason" />
          </Field>
          <Button type="submit">保存路由草稿</Button>
        </form>
      ) : null}
      {canMutateGlobalConfiguration &&
      hasPermission(auth.claims, 'routing:publish') &&
      view.status === 'DRAFT' ? (
        view.publishPreflight && Date.parse(view.publishPreflight.expiresAt) > Date.now() ? (
          <form action={publishRoutingAction} aria-label="发布路由策略">
            <input name="versionId" type="hidden" value={view.versionId} />
            <input name="expectedVersion" type="hidden" value={String(view.version)} />
            <input name="intentId" type="hidden" value={createUuidV7()} />
            <input name="previewToken" type="hidden" value={view.publishPreflight.previewToken} />
            <Text>
              权威差异：{view.publishPreflight.diff} · 影响：{view.publishPreflight.impact} · 有效至{' '}
              {view.publishPreflight.expiresAt}
            </Text>
            <Field label="发布原因">
              <Input name="reason" />
            </Field>
            <Checkbox label="确认发布路由策略" name="confirmed" value="true" />
            <Button type="submit">发布路由策略</Button>
          </form>
        ) : (
          <form action={previewRoutingAction} aria-label="路由发布预检">
            <input name="versionId" type="hidden" value={view.versionId} />
            <input name="expectedVersion" type="hidden" value={String(view.version)} />
            <Button type="submit">获取权威发布预检</Button>
          </form>
        )
      ) : null}
      <RoutingSimulator
        expectedVersion={view.version}
        onSimulate={simulateRoutingAction}
        permissions={auth.claims.permissions}
        versionId={view.versionId}
      />
      <Table aria-label="路由版本历史">
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
                {canMutateGlobalConfiguration &&
                hasPermission(auth.claims, 'routing:rollback') &&
                version.status !== 'DRAFT' ? (
                  <form action={rollbackRoutingAction}>
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
