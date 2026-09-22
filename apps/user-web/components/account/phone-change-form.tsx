'use client';

import { useEffect, useState } from 'react';

import { requestPhoneChangeCodesAction, verifyPhoneChangeAction } from '../../app/account-actions';
import { runAccountActionWithRefresh } from '../../lib/account/client-command';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { AccountActionResult, PhoneCodeRequestResult } from '../../lib/account/types';

const normalizePhone = (value: string) => (value.startsWith('+86') ? value : `+86${value}`);

export function PhoneChangeForm({
  onRequestCodes,
  onVerify,
}: {
  readonly onRequestCodes?: (
    phone: string,
    key: string,
  ) => Promise<AccountActionResult<PhoneCodeRequestResult>>;
  readonly onVerify?: (
    input: { currentPhoneCode: string; newPhoneE164: string; newPhoneCode: string },
    key: string,
  ) => Promise<AccountActionResult<{ readonly changed: true }>>;
}) {
  const [newPhone, setNewPhone] = useState('');
  const [oldCode, setOldCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [cooldown, setCooldown] = useState(0);
  const [requested, setRequested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = window.setInterval(() => {
      setCooldown((value) => Math.max(0, value - 1));
    }, 1_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [cooldown]);

  const request = async () => {
    const phone = normalizePhone(newPhone.trim());
    setError(undefined);
    if (!/^\+861[3-9]\d{9}$/.test(phone)) {
      setError('请输入有效的中国大陆手机号。');
      return;
    }
    setBusy(true);
    const key = createUuidV7();
    const result = onRequestCodes
      ? await onRequestCodes(phone, key)
      : await runAccountActionWithRefresh(key, (sameKey) =>
          requestPhoneChangeCodesAction(phone, sameKey),
        );
    setBusy(false);
    if (result.ok) {
      setRequested(true);
      setCooldown(result.data.cooldownSeconds);
      setStatus(result.data.message);
    } else {
      setError(
        result.outcome === 'UNCERTAIN'
          ? '发送结果待确认，请等待短信后再操作。'
          : '暂时无法发送验证码，请稍后重试。',
      );
    }
  };

  const verify = async () => {
    if (busy) return;
    setError(undefined);
    if (!/^\d{6}$/.test(oldCode) || !/^\d{6}$/.test(newCode)) {
      setError('请输入两个 6 位短信验证码。');
      return;
    }
    setBusy(true);
    const key = createUuidV7();
    const input = {
      currentPhoneCode: oldCode,
      newPhoneE164: normalizePhone(newPhone.trim()),
      newPhoneCode: newCode,
    };
    const result = onVerify
      ? await onVerify(input, key)
      : await runAccountActionWithRefresh(key, (sameKey) =>
          verifyPhoneChangeAction(input, sameKey),
        );
    setBusy(false);
    if (result.ok) {
      setStatus('手机号已安全换绑，账号和既有数据保持不变。');
      setOldCode('');
      setNewCode('');
    } else {
      setError(
        result.outcome === 'UNCERTAIN'
          ? '换绑结果待确认，请刷新安全设置核对。'
          : '无法完成验证，请检查验证码或稍后重试。',
      );
    }
  };

  return (
    <section className="settings-panel" aria-labelledby="phone-change-title">
      <p className="section-kicker">双重验证</p>
      <h2 id="phone-change-title">换绑手机号</h2>
      <p>验证码会分别发送到当前手机号和新手机号；发送结果统一显示，避免泄露账号状态。</p>
      <div className="settings-form">
        <label htmlFor="new-phone">新手机号</label>
        <input
          id="new-phone"
          type="tel"
          autoComplete="tel"
          value={newPhone}
          onChange={(event) => {
            setNewPhone(event.target.value);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'phone-help phone-change-error' : 'phone-help'}
        />
        <small id="phone-help">输入 11 位中国大陆手机号。</small>
        <button type="button" disabled={busy || cooldown > 0} onClick={() => void request()}>
          {cooldown > 0 ? `${String(cooldown)} 秒后重新发送` : '向两个手机号发送验证码'}
        </button>
        {requested ? (
          <>
            <label htmlFor="old-phone-code">原手机号验证码</label>
            <input
              id="old-phone-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={oldCode}
              onChange={(event) => {
                setOldCode(event.target.value);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'phone-change-error' : undefined}
            />
            <label htmlFor="new-phone-code">新手机号验证码</label>
            <input
              id="new-phone-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={newCode}
              onChange={(event) => {
                setNewCode(event.target.value);
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'phone-change-error' : undefined}
            />
            <button type="button" disabled={busy} onClick={() => void verify()}>
              确认换绑手机号
            </button>
          </>
        ) : null}
      </div>
      {status ? <p role="status">{status}</p> : null}
      {error ? (
        <p id="phone-change-error" role="alert" aria-live="assertive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
