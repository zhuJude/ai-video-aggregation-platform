'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState } from 'react';

import { cancelTaskAction, createRetryDraftAction } from '../../app/tasks/actions';
import { retryOnceAfterSessionRefresh } from '../../lib/auth/client-session';
import {
  formatPoints,
  formatTaskDate,
  parseCancelTaskResult,
  parseRetryDraft,
  reduceStatus,
} from '../../lib/tasks/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { TaskDetail } from '../../lib/tasks/types';
import { TaskStatus } from './task-status';
import { TaskResultActions } from './task-result-actions';

export interface TaskDetailCommands {
  cancelTask(taskId: string, options: { readonly idempotencyKey: string }): Promise<unknown>;
  createRetryDraft(taskId: string): Promise<unknown>;
}

interface TaskDetailViewProps {
  readonly detail: Omit<TaskDetail, 'parametersSnapshot'>;
  readonly gateway?: TaskDetailCommands;
  readonly live?: boolean;
  readonly navigate?: (href: string) => void;
}

export const serverTaskCommands: TaskDetailCommands = {
  cancelTask: (taskId, options) =>
    retryOnceAfterSessionRefresh(
      () => cancelTaskAction(taskId, options.idempotencyKey),
      (result) => !result.ok && result.outcome === 'SESSION_REFRESH_REQUIRED',
    ),
  createRetryDraft: async (taskId) => {
    const result = await retryOnceAfterSessionRefresh(
      () => createRetryDraftAction(taskId),
      (attempt) => !attempt.ok && attempt.outcome === 'SESSION_REFRESH_REQUIRED',
    );
    if (!result.ok) throw new Error(result.outcome);
    return { draftId: result.draftId };
  },
};

export function TaskDetailView({
  detail,
  gateway = serverTaskCommands,
  live = true,
  navigate,
}: TaskDetailViewProps) {
  const router = useRouter();
  const [status, setStatus] = useState(detail.statusSnapshot);
  const [canceling, setCanceling] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const cancelIdempotencyKey = useRef<string | undefined>(undefined);
  const cancelAccepted = useRef(false);

  const cancel = async () => {
    if (canceling || cancelAccepted.current || !status.cancelAllowed) return;
    setCanceling(true);
    setFeedback(undefined);
    try {
      cancelIdempotencyKey.current ??= createUuidV7();
      const result = parseCancelTaskResult(
        await gateway.cancelTask(detail.id, {
          idempotencyKey: cancelIdempotencyKey.current,
        }),
      );
      if (!result.ok) {
        if (result.outcome === 'DEFINITIVE_FAILURE') {
          cancelIdempotencyKey.current = undefined;
        }
        setFeedback('取消请求未完成，任务状态未更改，请稍后重试。');
        return;
      }
      cancelAccepted.current = true;
      cancelIdempotencyKey.current = undefined;
      setStatus((current) => reduceStatus(current, result.snapshot));
      setFeedback('取消请求已接受，费用将按任务快照规则处理。');
    } catch {
      setFeedback('取消请求未完成，任务状态未更改，请稍后重试。');
    } finally {
      setCanceling(false);
    }
  };

  const retry = async () => {
    if (retrying) return;
    setRetrying(true);
    setFeedback(undefined);
    try {
      const draft = parseRetryDraft(await gateway.createRetryDraft(detail.id));
      const href = `/studio?draft=${encodeURIComponent(draft.draftId)}`;
      if (navigate) navigate(href);
      else router.push(href);
    } catch {
      setFeedback('无法创建重试草稿，原任务和点数均未变更。');
      setRetrying(false);
    }
  };

  const financialItems = [
    ['可用点数', detail.financial.availablePoints],
    ['冻结点数', detail.financial.frozenPoints],
    ['已结算', detail.financial.settledPoints],
    ['已退回', detail.financial.refundedPoints],
  ] as const;

  return (
    <article className="task-detail">
      <header className="task-detail-hero">
        <div>
          <a className="back-link" href="/tasks">
            ← 返回任务中心
          </a>
          <p className="section-kicker">{detail.taskNumber}</p>
          <h1>{detail.modelName}</h1>
          <p>
            {detail.providerName} · {detail.generationMode}
          </p>
        </div>
        {live ? (
          <TaskStatus
            taskId={detail.id}
            initial={status}
            onChange={(next) => {
              setStatus(next);
            }}
          />
        ) : (
          <span className="task-status-chip" data-status={status.status}>
            {status.status}
          </span>
        )}
      </header>

      {status.publicReason ? (
        <p className="task-public-reason" role="status">
          {status.publicReason.message}
        </p>
      ) : null}
      {feedback ? (
        <p className="form-feedback" role="status">
          {feedback}
        </p>
      ) : null}

      <div className="task-detail-actions">
        {status.cancelAllowed && !cancelAccepted.current ? (
          <button disabled={canceling} type="button" onClick={() => void cancel()}>
            {canceling ? '正在提交取消' : '取消任务'}
          </button>
        ) : null}
        <button disabled={retrying} type="button" onClick={() => void retry()}>
          {retrying ? '正在创建报价草稿' : '复制参数并重新报价'}
        </button>
      </div>

      <div className="task-detail-grid">
        {detail.result && status.status === 'SETTLED' ? (
          <TaskResultActions taskId={detail.id} />
        ) : null}
        <section className="task-panel" aria-labelledby="snapshot-title">
          <div className="panel-heading">
            <h2 id="snapshot-title">模型与报价快照</h2>
            <span>提交时固化</span>
          </div>
          <dl className="snapshot-list">
            <div>
              <dt>模型 / 平台</dt>
              <dd>
                {detail.modelSnapshot.modelName} / {detail.modelSnapshot.providerName}
              </dd>
            </div>
            <div>
              <dt>能力版本</dt>
              <dd>{detail.modelSnapshot.capabilityVersion}</dd>
            </div>
            <div>
              <dt>定价版本</dt>
              <dd>{detail.modelSnapshot.pricingVersion}</dd>
            </div>
            <div>
              <dt>报价点数</dt>
              <dd>{formatPoints(detail.quotedPoints)}</dd>
            </div>
          </dl>
        </section>

        <section className="task-panel" aria-labelledby="finance-title">
          <div className="panel-heading">
            <h2 id="finance-title">点数状态</h2>
            <span>精确整数</span>
          </div>
          <dl className="financial-grid">
            {financialItems.map(([label, points]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{formatPoints(points)}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="task-panel task-parameters" aria-labelledby="parameters-title">
          <div className="panel-heading">
            <h2 id="parameters-title">参数快照</h2>
            <span>{detail.generationMode}</span>
          </div>
          <dl className="snapshot-list">
            {detail.parameterSummary.map((item) => (
              <div key={item.key}>
                <dt>{item.label}</dt>
                <dd>{item.value}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section className="task-panel task-timeline-panel" aria-labelledby="timeline-title">
          <div className="panel-heading">
            <h2 id="timeline-title">任务时间线</h2>
            <span>按服务端版本顺序</span>
          </div>
          <ol className="task-timeline" aria-label="任务时间线">
            {detail.timeline.map((item) => (
              <li key={`${item.eventId}-${String(item.revision)}`}>
                <span aria-hidden="true" />
                <div>
                  <p>{item.label}</p>
                  <time dateTime={item.updatedAt}>{formatTaskDate(item.updatedAt)}</time>
                  {item.publicReason ? <p>{item.publicReason.message}</p> : null}
                </div>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </article>
  );
}
