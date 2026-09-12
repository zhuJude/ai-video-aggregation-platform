import { TaskDetailView } from '../../../components/tasks/task-detail-view';
import { requireAuthenticatedServerSession } from '../../../lib/auth/server-session';
import { taskGateway } from '../../../lib/tasks/gateway';
import { parseTaskDetail } from '../../../lib/tasks/runtime';

interface TaskDetailPageProps {
  readonly params: Promise<{ readonly id: string }>;
}

export default async function TaskDetailPage({ params }: TaskDetailPageProps) {
  try {
    const { id } = await params;
    const session = await requireAuthenticatedServerSession();
    const detail = parseTaskDetail(await taskGateway.getTask(id, session));
    const { parametersSnapshot, ...publicDetail } = detail;
    void parametersSnapshot;
    return <TaskDetailView detail={publicDetail} />;
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <p className="section-kicker">任务详情</p>
        <h1>无法显示这个任务</h1>
        <p>任务可能已不存在，或详情暂时不可用。</p>
        <a className="button-link button-secondary" href="/tasks">
          返回任务中心
        </a>
      </section>
    );
  }
}
