'use client';

import { useState } from 'react';

import { exitAllSessionsAction, revokeSessionAction } from '../../app/account-actions';
import { runAccountActionWithRefresh } from '../../lib/account/client-command';
import { formatAccountDate } from '../../lib/account/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { AccountActionResult, SecuritySessionView } from '../../lib/account/types';
import { AccessibleDialog } from '../commerce/accessible-dialog';

type SimpleResult = AccountActionResult<{ readonly revoked: true } | { readonly signedOut: true }>;

export function SessionList({
  sessions,
  onRevoke,
  onExitAll,
}: {
  readonly sessions: readonly SecuritySessionView[];
  readonly onRevoke?: (handle: string, key: string) => Promise<SimpleResult>;
  readonly onExitAll?: (key: string) => Promise<SimpleResult>;
}) {
  const [items, setItems] = useState(sessions);
  const [target, setTarget] = useState<SecuritySessionView>();
  const [exitAllOpen, setExitAllOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string>();

  const revoke = async () => {
    if (!target || target.current || busy) return;
    setBusy(true);
    setFeedback(undefined);
    const key = createUuidV7();
    const result = onRevoke
      ? await onRevoke(target.handle, key)
      : await runAccountActionWithRefresh(key, (sameKey) =>
          revokeSessionAction(target.handle, sameKey),
        );
    setBusy(false);
    if (result.ok) {
      setItems((current) => current.filter(({ handle }) => handle !== target.handle));
      setTarget(undefined);
      setFeedback('该设备已退出。');
    } else {
      setFeedback(
        result.outcome === 'UNCERTAIN' ? '结果待确认，请刷新后核对。' : '退出失败，请稍后重试。',
      );
    }
  };

  const exitAll = async () => {
    if (busy) return;
    setBusy(true);
    setFeedback(undefined);
    const key = createUuidV7();
    const result = onExitAll
      ? await onExitAll(key)
      : await runAccountActionWithRefresh(key, exitAllSessionsAction);
    setBusy(false);
    if (result.ok) {
      setExitAllOpen(false);
      globalThis.location.assign('/login');
    } else {
      setFeedback(
        result.outcome === 'UNCERTAIN'
          ? '退出结果待确认，请重新打开页面核对。'
          : '暂时无法退出全部设备。',
      );
    }
  };

  return (
    <section className="settings-panel" aria-labelledby="session-title">
      <div className="settings-heading">
        <div>
          <p className="section-kicker">登录安全</p>
          <h2 id="session-title">设备与会话</h2>
        </div>
        <button
          type="button"
          className="danger-button"
          onClick={() => {
            setExitAllOpen(true);
          }}
        >
          退出全部设备
        </button>
      </div>
      {feedback ? <p role="status">{feedback}</p> : null}
      <div className="security-session-list">
        {items.map((session) => (
          <article key={session.handle}>
            <div>
              <h3>{session.deviceName}</h3>
              <p>{session.locationMasked}</p>
              {session.current ? <strong className="status-chip">当前设备</strong> : null}
            </div>
            <dl>
              <div>
                <dt>最近活动</dt>
                <dd>
                  <time dateTime={session.lastSeenAt}>{formatAccountDate(session.lastSeenAt)}</time>
                </dd>
              </div>
              <div>
                <dt>到期时间</dt>
                <dd>
                  <time dateTime={session.expiresAt}>{formatAccountDate(session.expiresAt)}</time>
                </dd>
              </div>
            </dl>
            {!session.current ? (
              <button
                type="button"
                onClick={() => {
                  setTarget(session);
                }}
              >
                退出 {session.deviceName}
              </button>
            ) : null}
          </article>
        ))}
      </div>
      {target ? (
        <AccessibleDialog
          labelledBy="revoke-session-title"
          onClose={() => {
            setTarget(undefined);
          }}
          busy={busy}
        >
          <h2 id="revoke-session-title">确认退出此设备</h2>
          <p>退出后，该设备需要重新登录才能访问账号。</p>
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => void revoke()}>
              {busy ? '正在退出…' : '确认退出'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setTarget(undefined);
              }}
            >
              取消
            </button>
          </div>
        </AccessibleDialog>
      ) : null}
      {exitAllOpen ? (
        <AccessibleDialog
          labelledBy="exit-all-title"
          onClose={() => {
            setExitAllOpen(false);
          }}
          busy={busy}
        >
          <h2 id="exit-all-title">退出全部设备</h2>
          <p>包括当前设备在内的所有登录都会立即失效。</p>
          <div className="dialog-actions">
            <button type="button" disabled={busy} onClick={() => void exitAll()}>
              {busy ? '正在退出…' : '确认退出全部设备'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setExitAllOpen(false);
              }}
            >
              取消
            </button>
          </div>
        </AccessibleDialog>
      ) : null}
    </section>
  );
}
