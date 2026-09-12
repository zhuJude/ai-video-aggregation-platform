'use client';

import { useState } from 'react';

import { closeAccountAction } from '../../app/account-actions';
import { runAccountActionWithRefresh } from '../../lib/account/client-command';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { AccountActionResult } from '../../lib/account/types';
import { AccessibleDialog } from '../commerce/accessible-dialog';

const PHRASE = '注销账号';

export function AccountDeletion({
  onDelete,
  cooldownSeconds,
}: {
  readonly onDelete?: (
    code: string,
    key: string,
  ) => Promise<AccountActionResult<{ readonly closed: true }>>;
  readonly cooldownSeconds: number;
}) {
  const [phrase, setPhrase] = useState('');
  const [code, setCode] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const eligible = phrase === PHRASE && /^\d{6}$/.test(code) && cooldownSeconds <= 0;

  const close = async () => {
    if (!eligible || busy) return;
    setBusy(true);
    setError(undefined);
    const key = createUuidV7();
    const result = onDelete
      ? await onDelete(code, key)
      : await runAccountActionWithRefresh(key, (sameKey) => closeAccountAction(code, sameKey));
    setBusy(false);
    if (result.ok) globalThis.location.assign('/login');
    else
      setError(
        result.outcome === 'UNCERTAIN'
          ? '注销结果待确认，请勿重复提交并重新登录核对。'
          : '无法注销账号，请检查验证码或稍后重试。',
      );
  };

  return (
    <section className="settings-panel danger-zone" aria-labelledby="delete-account-title">
      <p className="section-kicker">危险操作</p>
      <h2 id="delete-account-title">永久注销账号</h2>
      <p>
        注销后登录立即失效；点数余额将按服务条款处理，作品、素材和进行中的任务可能无法继续访问，依法需保留的订单与发票记录除外。
      </p>
      <div className="settings-form">
        <label htmlFor="delete-phrase">输入确认短语</label>
        <input
          id="delete-phrase"
          value={phrase}
          onChange={(event) => {
            setPhrase(event.target.value);
          }}
          aria-describedby="delete-phrase-help"
        />
        <small id="delete-phrase-help">请输入“{PHRASE}”。</small>
        <label htmlFor="delete-code">短信验证码</label>
        <input
          id="delete-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
          }}
        />
        <button
          type="button"
          className="danger-button"
          disabled={!eligible || busy}
          onClick={() => {
            setOpen(true);
          }}
        >
          继续注销
        </button>
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {open ? (
        <AccessibleDialog
          labelledBy="delete-confirm-title"
          onClose={() => {
            setOpen(false);
          }}
          busy={busy}
        >
          <h2 id="delete-confirm-title">最后确认</h2>
          <p>
            作品访问和未完成服务将受到影响，剩余点数可能无法恢复。此操作完成后当前登录会立即失效。
          </p>
          <div className="dialog-actions">
            <button
              type="button"
              className="danger-button"
              disabled={busy}
              onClick={() => void close()}
            >
              {busy ? '正在注销…' : '永久注销账号'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setOpen(false);
              }}
            >
              暂不注销
            </button>
          </div>
        </AccessibleDialog>
      ) : null}
    </section>
  );
}
