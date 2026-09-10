import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Link,
  Select,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
} from '@fluentui/react-components';
import { createHttpOperationsPorts } from '../../../lib/http-operations-port';
import { loadTaskDirectoryView, type TaskOperationsPort } from '../../../lib/operations-server';
import { hasPermission } from '../../../lib/permissions';
import { requireAdminAuthorization, type ServerGuardContext } from '../../../lib/server-guard';
import { createUuidV7 } from '../../../lib/uuid-v7';
import { executeQueueAction } from './actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export async function renderTasksPage(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    cursor?: string;
    port: TaskOperationsPort;
    query?: string;
    status?: string;
  }>,
) {
  const [auth, view] = await Promise.all([
    requireAdminAuthorization('tasks:read', dependencies.context),
    loadTaskDirectoryView(dependencies),
  ]);
  const queueStateAction = view.queue.paused ? 'RESUME' : 'PAUSE';
  const queueStatePreview = view.queue.operationPreviews.find(
    (preview) => preview.action === queueStateAction && Date.parse(preview.expiresAt) > Date.now(),
  );
  const queueLimitsPreview = view.queue.operationPreviews.find(
    (preview) => preview.action === 'UPDATE_LIMITS' && Date.parse(preview.expiresAt) > Date.now(),
  );
  return (
    <section aria-labelledby="tasks-heading">
      <Title2 as="h2" id="tasks-heading">
        任务运营
      </Title2>
      <Text>权威数据时间：{view.sourceUpdatedAt}</Text>
      <form method="get">
        <Field label="任务 / 用户 / 外部请求号">
          <Input defaultValue={dependencies.query ?? ''} name="query" />
        </Field>
        <Field label="状态">
          <Select defaultValue={dependencies.status ?? ''} name="status">
            <option value="">全部</option>
            <option value="QUEUED">排队中</option>
            <option value="PROVIDER_PENDING">供应商处理中</option>
            <option value="FAILED">失败</option>
            <option value="SUCCEEDED">成功</option>
          </Select>
        </Field>
        <Button type="submit">检索任务</Button>
      </form>
      <Text>
        队列：运行 {String(view.queue.running)} · 积压 {String(view.queue.backlog)} · 限速{' '}
        {String(view.queue.rateLimitPerMinute)}/分钟 · 并发 {String(view.queue.concurrencyLimit)} ·
        默认优先级 {String(view.queue.defaultPriority)} · {view.queue.paused ? '已暂停' : '运行中'}
      </Text>
      {hasPermission(auth.claims, view.queue.paused ? 'tasks:queue-resume' : 'tasks:queue-pause') &&
      queueStatePreview ? (
        <form
          action={executeQueueAction}
          aria-label={view.queue.paused ? '恢复任务队列' : '暂停任务队列'}
        >
          <input name="action" type="hidden" value={view.queue.paused ? 'RESUME' : 'PAUSE'} />
          <input name="expectedPaused" type="hidden" value={String(view.queue.paused)} />
          <input name="expectedVersion" type="hidden" value={String(view.queue.version)} />
          <input name="impactToken" type="hidden" value={queueStatePreview.preflightToken} />
          <input name="intentId" type="hidden" value={createUuidV7()} />
          <Text>{queueStatePreview.impact}</Text>
          <Field label="操作原因">
            <Input maxLength={200} name="reason" />
          </Field>
          <Checkbox
            label={view.queue.paused ? '确认恢复任务队列' : '确认暂停任务队列'}
            name="confirmed"
            value="true"
          />
          <Button type="submit">{view.queue.paused ? '恢复队列' : '暂停队列'}</Button>
        </form>
      ) : null}
      {hasPermission(auth.claims, 'tasks:priority-write') && queueLimitsPreview ? (
        <form action={executeQueueAction} aria-label="调整任务队列限制">
          <input name="action" type="hidden" value="UPDATE_LIMITS" />
          <input name="expectedPaused" type="hidden" value={String(view.queue.paused)} />
          <input name="expectedVersion" type="hidden" value={String(view.queue.version)} />
          <input name="impactToken" type="hidden" value={queueLimitsPreview.preflightToken} />
          <input name="intentId" type="hidden" value={createUuidV7()} />
          <Text>{queueLimitsPreview.impact}</Text>
          <Field label="并发上限">
            <Input
              defaultValue={String(view.queue.concurrencyLimit)}
              min={1}
              name="concurrencyLimit"
              type="number"
            />
          </Field>
          <Field label="每分钟限速">
            <Input
              defaultValue={String(view.queue.rateLimitPerMinute)}
              min={0}
              name="rateLimitPerMinute"
              type="number"
            />
          </Field>
          <Field label="默认优先级（0-100）">
            <Input
              defaultValue={String(view.queue.defaultPriority)}
              max={100}
              min={0}
              name="defaultPriority"
              type="number"
            />
          </Field>
          <Field label="调整原因">
            <Input maxLength={200} name="reason" />
          </Field>
          <Checkbox label="确认更新队列限制" name="confirmed" value="true" />
          <Button type="submit">更新队列限制</Button>
        </form>
      ) : null}
      {view.partialFields.length ? (
        <Text role="alert">部分字段暂不可用：{view.partialFields.join('、')}</Text>
      ) : null}
      {view.items.length === 0 ? (
        <Text>当前数据范围内暂无任务</Text>
      ) : (
        <Table aria-label="任务目录">
          <TableHeader>
            <TableRow>
              <TableHeaderCell>任务</TableHeaderCell>
              <TableHeaderCell>用户</TableHeaderCell>
              <TableHeaderCell>供应商</TableHeaderCell>
              <TableHeaderCell>状态</TableHeaderCell>
              <TableHeaderCell>更新时间</TableHeaderCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {view.items.map((task) => (
              <TableRow key={task.id}>
                <TableCell>
                  <Link href={`/tasks/${encodeURIComponent(task.id)}`}>{task.id}</Link>
                </TableCell>
                <TableCell>{task.userIdMasked}</TableCell>
                <TableCell>{task.providerName}</TableCell>
                <TableCell>
                  <Badge>{task.status}</Badge>
                </TableCell>
                <TableCell>{task.updatedAt}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {view.nextCursor ? (
        <Link
          href={`/tasks?cursor=${encodeURIComponent(view.nextCursor)}&query=${encodeURIComponent(dependencies.query ?? '')}&status=${encodeURIComponent(dependencies.status ?? '')}`}
        >
          下一页
        </Link>
      ) : null}
    </section>
  );
}
export default async function TasksPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ cursor?: string; query?: string; status?: string }> }>) {
  const filters = await searchParams;
  return renderTasksPage({ ...filters, port: createHttpOperationsPorts().tasks });
}
