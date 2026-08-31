'use client';

import { useEffect, useRef, useState } from 'react';

import { apiClient } from '../../lib/api-client';
import { openTaskEventStream } from '../../lib/task-event-stream';
import { parseTaskDetail, parseTaskStatusSnapshot, reduceStatus } from '../../lib/tasks/runtime';
import type { TaskStatusSnapshot } from '../../lib/tasks/types';

const BACKOFF_MS = [1_000, 2_000] as const;
const POLL_MS = 5_000;

const STATUS_LABELS: Readonly<Record<TaskStatusSnapshot['status'], string>> = {
  QUOTED: '已报价',
  RESERVED: '已冻结点数',
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

interface TaskStatusProps {
  readonly initial: TaskStatusSnapshot;
  readonly onChange?: (snapshot: TaskStatusSnapshot) => void;
  readonly taskId: string;
}

export function TaskStatus({ initial, onChange, taskId }: TaskStatusProps) {
  const [snapshot, setSnapshot] = useState(initial);
  const currentRef = useRef(initial);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    currentRef.current = initial;
    setSnapshot(initial);
  }, [initial]);

  useEffect(() => {
    if (currentRef.current.terminal) return;
    const lifetime = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;
    let activeStream: AbortController | undefined;
    let failures = 0;

    const apply = (next: TaskStatusSnapshot) => {
      const reduced = reduceStatus(currentRef.current, next);
      if (reduced === currentRef.current) return;
      currentRef.current = reduced;
      setSnapshot(reduced);
      onChangeRef.current?.(reduced);
      if (reduced.terminal) {
        activeStream?.abort();
        if (retryTimer) clearTimeout(retryTimer);
        if (pollTimer) clearTimeout(pollTimer);
      }
    };

    const schedulePoll = () => {
      if (lifetime.signal.aborted || currentRef.current.terminal) return;
      pollTimer = setTimeout(() => {
        void apiClient<unknown>(`/v1/tasks/${encodeURIComponent(taskId)}`, {
          signal: lifetime.signal,
        })
          .then((response) => {
            apply(parseTaskDetail(response.data).statusSnapshot);
          })
          .catch(() => undefined)
          .finally(schedulePoll);
      }, POLL_MS);
    };

    const connect = () => {
      if (lifetime.signal.aborted || currentRef.current.terminal) return;
      activeStream = new AbortController();
      const abortStream = () => {
        activeStream?.abort();
      };
      lifetime.signal.addEventListener('abort', abortStream, { once: true });
      void openTaskEventStream(taskId, {
        lastEventId: currentRef.current.eventId,
        signal: activeStream.signal,
        onEvent: (event) => {
          failures = 0;
          apply(parseTaskStatusSnapshot(event.data, event.eventId));
        },
      })
        .catch(() => {
          if (lifetime.signal.aborted || currentRef.current.terminal) return;
          failures += 1;
          // Three cumulative failures: the initial connection, then 1s and 2s reconnects.
          if (failures > BACKOFF_MS.length) {
            schedulePoll();
            return;
          }
          retryTimer = setTimeout(connect, BACKOFF_MS[failures - 1]);
        })
        .finally(() => {
          lifetime.signal.removeEventListener('abort', abortStream);
        });
    };

    connect();
    return () => {
      lifetime.abort();
      activeStream?.abort();
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearTimeout(pollTimer);
    };
  }, [initial.terminal, taskId]);

  return (
    <div className="task-live-status" data-status={snapshot.status}>
      <span className="status-dot" aria-hidden="true" />
      <span aria-live="polite" aria-atomic="true">
        {STATUS_LABELS[snapshot.status]}
      </span>
    </div>
  );
}
