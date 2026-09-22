import { Title2 } from '@fluentui/react-components';
import {
  TaskActions,
  TaskOperationsPanel,
} from '../../../../components/operations/task-operations';
import { createHttpOperationsPorts } from '../../../../lib/http-operations-port';
import { loadTaskDetailView, type TaskOperationsPort } from '../../../../lib/operations-server';
import type { ServerGuardContext } from '../../../../lib/server-guard';
import { requireAdminAuthorization } from '../../../../lib/server-guard';
import { executeTaskAction, loadTaskRawAction } from '../actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export async function renderTaskDetailPage(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    port: TaskOperationsPort;
    taskId: string;
  }>,
) {
  const [task, auth] = await Promise.all([
    loadTaskDetailView(dependencies),
    requireAdminAuthorization('tasks:read', dependencies.context),
  ]);
  const loadRaw = loadTaskRawAction.bind(null, task.id);
  return (
    <section aria-labelledby="task-heading">
      <Title2 as="h2" id="task-heading">
        任务 {task.id}
      </Title2>
      <TaskOperationsPanel onLoadRaw={loadRaw} permissions={auth.claims.permissions} task={task} />
      <TaskActions onAction={executeTaskAction} permissions={auth.claims.permissions} task={task} />
    </section>
  );
}
export default async function TaskDetailPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params;
  return renderTaskDetailPage({ port: createHttpOperationsPorts().tasks, taskId: id });
}
