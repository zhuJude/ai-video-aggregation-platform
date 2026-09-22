'use client';

import Link from 'next/link';
import { useState } from 'react';

import { markMessagesReadAction } from '../../app/support-actions';
import { runSupportActionWithRefresh } from '../../lib/support/client-command';
import { formatSupportDate } from '../../lib/support/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { MessagePage, SupportActionResult } from '../../lib/support/types';

const kindLabel = { TASK: '任务', PAYMENT: '支付', BALANCE: '余额', SYSTEM: '系统' } as const;

export function MessageCenter({
  initial,
  onMarkRead,
}: {
  readonly initial: MessagePage;
  readonly onMarkRead?: (
    ids: readonly string[],
    key: string,
  ) => Promise<SupportActionResult<{ readonly readAt: string }>>;
}) {
  const [items, setItems] = useState(initial.items);
  const [unreadCount, setUnreadCount] = useState(initial.unreadCount);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const pageUnreadCount = items.filter(({ readAt }) => !readAt).length;

  const mark = async (ids: readonly string[]) => {
    if (pending || ids.length === 0) return;
    setPending(true);
    setError(undefined);
    const key = createUuidV7();
    const result = onMarkRead
      ? await onMarkRead(ids, key)
      : await runSupportActionWithRefresh(key, (sameKey) => markMessagesReadAction(ids, sameKey));
    setPending(false);
    if (result.ok) {
      const selected = new Set(ids);
      const newlyRead = items.filter((item) => selected.has(item.id) && !item.readAt).length;
      setUnreadCount((current) => Math.max(0, current - newlyRead));
      setItems((current) =>
        current.map((item) =>
          selected.has(item.id) ? { ...item, readAt: result.data.readAt } : item,
        ),
      );
    } else {
      setError(
        result.outcome === 'UNCERTAIN'
          ? '已读状态待确认，请刷新消息列表核对。'
          : '未能更新已读状态，请稍后重试。',
      );
    }
  };

  return (
    <section className="support-panel" aria-labelledby="messages-title">
      <div className="settings-heading">
        <div>
          <p className="section-kicker">通知中心</p>
          <h1 id="messages-title">消息</h1>
          <p role="status" aria-live="polite">
            {unreadCount} 条未读
          </p>
        </div>
        <button
          type="button"
          disabled={pending || pageUnreadCount === 0}
          onClick={() => void mark(items.filter(({ readAt }) => !readAt).map(({ id }) => id))}
        >
          将本页标为已读
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {items.length === 0 ? (
        <div className="commerce-empty" role="status">
          <h2>暂无消息</h2>
          <p>任务、支付和安全通知会显示在这里。</p>
        </div>
      ) : (
        <div className="message-list">
          {items.map((message) => (
            <article key={message.id} data-unread={!message.readAt}>
              <div>
                <span className="status-chip">{kindLabel[message.kind]}</span>
                <h2>{message.title}</h2>
                <p>{message.summary}</p>
                <time dateTime={message.occurredAt}>{formatSupportDate(message.occurredAt)}</time>
              </div>
              <div className="message-actions">
                {message.deepLink ? <Link href={message.deepLink}>查看详情</Link> : null}
                {!message.readAt ? (
                  <button
                    type="button"
                    disabled={pending}
                    aria-label={`将“${message.title}”标为已读`}
                    onClick={() => void mark([message.id])}
                  >
                    标为已读
                  </button>
                ) : (
                  <span>已读</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
