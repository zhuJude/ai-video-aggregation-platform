import { TaskList } from '../../components/tasks/task-list';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { taskGateway } from '../../lib/tasks/gateway';
import { parseTaskFilters, parseTaskPage } from '../../lib/tasks/runtime';
import { redirect } from 'next/navigation';

interface TasksPageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function TasksPage({ searchParams }: TasksPageProps) {
  const sessionState = await readAuthenticatedServerSessionState();
  if (sessionState.kind === 'needs-refresh') {
    redirect('/auth/session/refresh?returnTo=%2Ftasks');
  }
  try {
    const filters = parseTaskFilters(await searchParams);
    if (sessionState.kind !== 'active') throw new Error('AUTHENTICATION_REQUIRED');
    const session = sessionState.session;
    const page = parseTaskPage(await taskGateway.listTasks(filters, session));
    return <TaskList filters={filters} page={page} />;
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <p className="section-kicker">任务中心</p>
        <h1>暂时无法加载任务</h1>
        <p>请检查筛选条件或网络连接后重试。</p>
        <a className="button-link button-secondary" href="/tasks">
          重新加载
        </a>
      </section>
    );
  }
}
