import Link from 'next/link';

import { formatPoints, formatTaskDate } from '../../lib/tasks/runtime';
import type { TaskFilters, TaskPage, TaskStatus } from '../../lib/tasks/types';

interface TaskListProps {
  readonly filters: TaskFilters;
  readonly page: TaskPage;
}

const statusLabels: Readonly<Record<TaskStatus, string>> = {
  QUOTED: '已报价',
  RESERVED: '已冻结',
  QUEUED: '排队中',
  SUBMITTING: '提交中',
  RUNNING: '生成中',
  SUCCEEDED: '生成成功',
  FAILED: '生成失败',
  CANCELED: '已取消',
  EXPIRED: '已过期',
  SETTLED: '已结算',
  REFUNDED: '已退款',
};

const modeLabels = {
  TEXT_TO_VIDEO: '文生视频',
  IMAGE_TO_VIDEO: '图生视频',
  FIRST_LAST_FRAME: '首尾帧生视频',
  REFERENCE_VIDEO: '参考生视频',
  EXTEND_VIDEO: '视频延长',
} as const;

function pageHref(filters: TaskFilters, cursor: string): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (key !== 'cursor' && value) query.set(key, String(value));
  }
  query.set('cursor', cursor);
  return `/tasks?${query.toString()}`;
}

export function TaskList({ filters, page }: TaskListProps) {
  return (
    <div className="task-center">
      <header className="task-center-heading">
        <div>
          <p className="section-kicker">任务中心</p>
          <h1>跟踪每一次生成</h1>
        </div>
        <p>状态由 Gateway 实时同步；断线后会自动恢复。</p>
      </header>

      <form className="task-filters" action="/tasks" method="get" aria-label="筛选任务">
        <label>
          <span>状态</span>
          <select name="status" defaultValue={filters.status ?? ''}>
            <option value="">全部状态</option>
            {Object.entries(statusLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>时间</span>
          <select name="time" defaultValue={filters.time ?? ''}>
            <option value="">全部时间</option>
            <option value="TODAY">今天</option>
            <option value="LAST_7_DAYS">近 7 天</option>
            <option value="LAST_30_DAYS">近 30 天</option>
          </select>
        </label>
        <label>
          <span>模型</span>
          <select name="model" defaultValue={filters.model ?? ''}>
            <option value="">全部模型</option>
            <option value="mock-cinema-v2">Cinema V2</option>
            <option value="mock-story-v3">Story V3</option>
          </select>
        </label>
        <label>
          <span>生成方式</span>
          <select name="generationMode" defaultValue={filters.generationMode ?? ''}>
            <option value="">全部方式</option>
            {Object.entries(modeLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>任务编号</span>
          <input name="taskNumber" defaultValue={filters.taskNumber ?? ''} placeholder="T2026…" />
        </label>
        <button className="button-link button-primary" type="submit">
          查询
        </button>
      </form>

      {page.items.length === 0 ? (
        <section className="task-empty" aria-live="polite">
          <h2>没有匹配的任务</h2>
          <p>调整筛选条件，或前往生成工作台创建新任务。</p>
          <Link className="button-link button-secondary" href="/studio">
            开始生成
          </Link>
        </section>
      ) : (
        <ul className="task-card-list" aria-label="任务列表">
          {page.items.map((task) => (
            <li key={task.id} className="task-card">
              <div className="task-card-topline">
                <span className="task-number">{task.taskNumber}</span>
                <span className="task-status-chip" data-status={task.statusSnapshot.status}>
                  {statusLabels[task.statusSnapshot.status]}
                </span>
              </div>
              <h2>{task.modelName}</h2>
              <p>
                {task.providerName} · {modeLabels[task.generationMode]}
              </p>
              <dl className="task-card-meta">
                <div>
                  <dt>创建时间</dt>
                  <dd>{formatTaskDate(task.createdAt)}</dd>
                </div>
                <div>
                  <dt>报价点数</dt>
                  <dd>{formatPoints(task.quotedPoints)}</dd>
                </div>
              </dl>
              <Link className="task-card-link" href={`/tasks/${encodeURIComponent(task.id)}`}>
                查看任务 <span aria-hidden="true">↗</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <nav className="task-pagination" aria-label="任务分页">
        {page.pageInfo.previousCursor ? (
          <Link href={pageHref(filters, page.pageInfo.previousCursor)}>上一页</Link>
        ) : (
          <span aria-disabled="true">上一页</span>
        )}
        {page.pageInfo.nextCursor ? (
          <Link href={pageHref(filters, page.pageInfo.nextCursor)}>下一页</Link>
        ) : (
          <span aria-disabled="true">下一页</span>
        )}
      </nav>
    </div>
  );
}
