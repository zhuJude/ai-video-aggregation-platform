'use client';

import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

import { ApiClientError, apiClient } from '../../lib/api-client';

const PHONE_PATTERN = /^1\d{10}$/;
const CODE_PATTERN = /^\d{6}$/;
const DEFAULT_COOLDOWN_SECONDS = 60;
const REQUEST_MESSAGE = '如果该手机号可用，验证码将尽快发送。';
const REQUEST_ERROR_MESSAGE = '请稍后重试，我们不会透露该手机号是否已注册。';

type PendingAction = 'request' | 'verify' | null;

function createIdempotencyKey(action: 'request' | 'verify'): string {
  return `sms-${action}-${crypto.randomUUID()}`;
}

function retryAfterSeconds(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

export function PhoneLoginForm() {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (cooldownSeconds <= 0) return;

    const timer = window.setInterval(() => {
      setCooldownSeconds((seconds) => Math.max(0, seconds - 1));
    }, 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [cooldownSeconds]);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  function validatePhone(): boolean {
    if (PHONE_PATTERN.test(phone)) return true;

    setError('请输入 11 位手机号');
    setStatusMessage('');
    queueMicrotask(() => phoneInputRef.current?.focus());
    return false;
  }

  async function requestSmsCode() {
    if (pendingAction || cooldownSeconds > 0 || !validatePhone()) return;

    setError('');
    setStatusMessage('');
    setPendingAction('request');

    try {
      const response = await apiClient<unknown>('/v1/auth/sms/request', {
        method: 'POST',
        body: { phone },
        idempotencyKey: createIdempotencyKey('request'),
      });
      setCooldownSeconds(
        Math.max(DEFAULT_COOLDOWN_SECONDS, retryAfterSeconds(response.headers) ?? 0),
      );
      setStatusMessage(REQUEST_MESSAGE);
      queueMicrotask(() => codeInputRef.current?.focus());
    } catch (requestError) {
      if (requestError instanceof ApiClientError && requestError.retryAfterSeconds !== undefined) {
        setCooldownSeconds(Math.max(DEFAULT_COOLDOWN_SECONDS, requestError.retryAfterSeconds));
      }
      setError(REQUEST_ERROR_MESSAGE);
    } finally {
      setPendingAction(null);
    }
  }

  async function submitCode(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (pendingAction || !validatePhone()) return;
    if (!CODE_PATTERN.test(code)) {
      setError('请输入 6 位数字验证码');
      setStatusMessage('');
      queueMicrotask(() => codeInputRef.current?.focus());
      return;
    }

    setError('');
    setStatusMessage('');
    setPendingAction('verify');

    try {
      await apiClient('/v1/auth/sms/verify', {
        method: 'POST',
        body: { code, phone },
        idempotencyKey: createIdempotencyKey('verify'),
      });
      setStatusMessage('登录成功，正在进入工作台。');
      globalThis.location.assign('/');
    } catch (verifyError) {
      const invalidCode =
        verifyError instanceof ApiClientError &&
        ['INVALID_SMS_CODE', 'SMS_CHALLENGE_LOCKED', 'SMS_CODE_EXPIRED'].includes(verifyError.code);
      setError(invalidCode ? '验证码错误' : '暂时无法登录，请稍后重试');
    } finally {
      setPendingAction(null);
    }
  }

  const isBusy = pendingAction !== null;
  const requestButtonLabel =
    cooldownSeconds > 0
      ? `重新发送（${String(cooldownSeconds)} 秒）`
      : pendingAction === 'request'
        ? '正在发送……'
        : '获取验证码';

  return (
    <form
      className="phone-login-form"
      noValidate
      onSubmit={(event) => {
        void submitCode(event);
      }}
    >
      <div className="form-field">
        <label htmlFor="phone">手机号</label>
        <input
          ref={phoneInputRef}
          id="phone"
          name="phone"
          type="tel"
          autoComplete="tel-national"
          inputMode="numeric"
          maxLength={11}
          pattern="1[0-9]{10}"
          value={phone}
          aria-describedby="phone-help"
          aria-invalid={Boolean(error && !PHONE_PATTERN.test(phone))}
          disabled={pendingAction === 'verify'}
          onChange={(event) => {
            setPhone(event.target.value.replace(/\D/g, ''));
          }}
        />
        <p id="phone-help" className="field-help">
          仅支持中国大陆 11 位手机号。
        </p>
      </div>

      <div className="form-field verification-field">
        <div>
          <label htmlFor="sms-code">短信验证码</label>
          <input
            ref={codeInputRef}
            id="sms-code"
            name="code"
            type="text"
            autoComplete="one-time-code"
            inputMode="numeric"
            maxLength={6}
            pattern="[0-9]{6}"
            value={code}
            aria-invalid={Boolean(error && phone.length === 11 && !CODE_PATTERN.test(code))}
            disabled={pendingAction === 'verify'}
            onChange={(event) => {
              setCode(event.target.value.replace(/\D/g, ''));
            }}
          />
        </div>
        <button
          className="secondary-button sms-request-button"
          type="button"
          disabled={isBusy || cooldownSeconds > 0}
          aria-busy={pendingAction === 'request'}
          onClick={() => {
            void requestSmsCode();
          }}
        >
          {requestButtonLabel}
        </button>
      </div>

      {error ? (
        <p ref={errorRef} className="form-feedback form-error" role="alert" tabIndex={-1}>
          {error}
        </p>
      ) : null}
      {statusMessage ? (
        <p className="form-feedback" role="status">
          {statusMessage}
        </p>
      ) : null}

      <button
        className="login-submit"
        type="submit"
        disabled={isBusy}
        aria-busy={pendingAction === 'verify'}
      >
        {pendingAction === 'verify' ? '正在登录……' : '登录'}
      </button>
    </form>
  );
}
