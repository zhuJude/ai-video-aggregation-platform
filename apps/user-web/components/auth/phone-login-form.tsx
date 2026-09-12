'use client';

import { useEffect, useRef, useState, type SyntheticEvent } from 'react';

import { requestPhoneLoginCodeAction, verifyPhoneLoginAction } from '../../app/login/actions';

const PHONE_PATTERN = /^1\d{10}$/;
const CODE_PATTERN = /^\d{6}$/;
const DEFAULT_COOLDOWN_SECONDS = 60;
const REQUEST_MESSAGE = '如果该手机号可用，验证码将尽快发送。';
const REQUEST_ERROR_MESSAGE = '请稍后重试，我们不会透露该手机号是否已注册。';
const ERROR_ID = 'phone-login-error';

type PendingAction = 'request' | 'verify' | null;
type WorkspaceDestination = '/studio';
type ErrorField = 'code' | 'form' | 'phone';

interface LoginError {
  field: ErrorField;
  kind: 'server' | 'validation';
  message: string;
}

interface ActiveRequest {
  controller: AbortController;
  generation: number;
}

interface PhoneLoginFormProps {
  onAuthenticated?: (destination: WorkspaceDestination) => void;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

export function PhoneLoginForm({ onAuthenticated }: PhoneLoginFormProps = {}) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [error, setError] = useState<LoginError | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const phoneInputRef = useRef<HTMLInputElement>(null);
  const codeInputRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const activeRequestRef = useRef<ActiveRequest | null>(null);
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestGenerationRef.current += 1;
      const activeRequest = activeRequestRef.current;
      activeRequestRef.current = null;
      activeRequest?.controller.abort(
        new DOMException('The login form was unmounted.', 'AbortError'),
      );
    };
  }, []);

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
    if (!error) return;

    if (error.kind === 'validation' && error.field === 'phone') {
      phoneInputRef.current?.focus();
    } else if (error.kind === 'validation' && error.field === 'code') {
      codeInputRef.current?.focus();
    } else {
      errorRef.current?.focus();
    }
  }, [error]);

  function beginRequest(): ActiveRequest {
    const previousRequest = activeRequestRef.current;
    const request: ActiveRequest = {
      controller: new AbortController(),
      generation: requestGenerationRef.current + 1,
    };
    requestGenerationRef.current = request.generation;
    activeRequestRef.current = request;
    previousRequest?.controller.abort(
      new DOMException('A newer login request superseded this request.', 'AbortError'),
    );
    return request;
  }

  function isCurrentRequest(request: ActiveRequest): boolean {
    return (
      mountedRef.current &&
      requestGenerationRef.current === request.generation &&
      activeRequestRef.current === request
    );
  }

  function finishRequest(request: ActiveRequest) {
    if (!isCurrentRequest(request)) return;
    activeRequestRef.current = null;
    setPendingAction(null);
  }

  function cancelActiveRequest() {
    requestGenerationRef.current += 1;
    const activeRequest = activeRequestRef.current;
    activeRequestRef.current = null;
    activeRequest?.controller.abort(new DOMException('The login input changed.', 'AbortError'));
  }

  function handlePhoneChange(nextPhone: string) {
    if (nextPhone === phone) return;
    cancelActiveRequest();
    setPhone(nextPhone);
    setCode('');
    setCooldownSeconds(0);
    setPendingAction(null);
    setStatusMessage('');
    setError(null);
  }

  function handleCodeChange(nextCode: string) {
    setCode(nextCode);
    setError((currentError) =>
      currentError?.field === 'code' || currentError?.field === 'form' ? null : currentError,
    );
  }

  function validatePhone(): boolean {
    if (PHONE_PATTERN.test(phone)) return true;

    setError({ field: 'phone', kind: 'validation', message: '请输入 11 位手机号' });
    setStatusMessage('');
    return false;
  }

  async function requestSmsCode() {
    if (activeRequestRef.current || pendingAction || cooldownSeconds > 0 || !validatePhone()) {
      return;
    }

    setError(null);
    setStatusMessage('');
    setPendingAction('request');
    const request = beginRequest();

    try {
      const response = await requestPhoneLoginCodeAction(phone);
      if (!isCurrentRequest(request)) return;
      if (!response.ok) {
        if (response.cooldownSeconds !== undefined) {
          setCooldownSeconds(Math.max(DEFAULT_COOLDOWN_SECONDS, response.cooldownSeconds));
        }
        setError({ field: 'form', kind: 'server', message: REQUEST_ERROR_MESSAGE });
        return;
      }
      setCooldownSeconds(Math.max(DEFAULT_COOLDOWN_SECONDS, response.cooldownSeconds));
      setStatusMessage(REQUEST_MESSAGE);
      queueMicrotask(() => {
        if (mountedRef.current && requestGenerationRef.current === request.generation) {
          codeInputRef.current?.focus();
        }
      });
    } catch (requestError) {
      if (!isCurrentRequest(request) || isAbortError(requestError)) return;
      setError({ field: 'form', kind: 'server', message: REQUEST_ERROR_MESSAGE });
    } finally {
      finishRequest(request);
    }
  }

  async function submitCode(event: SyntheticEvent<HTMLFormElement, SubmitEvent>) {
    event.preventDefault();
    if (activeRequestRef.current || pendingAction || !validatePhone()) return;
    if (!CODE_PATTERN.test(code)) {
      setError({ field: 'code', kind: 'validation', message: '请输入 6 位数字验证码' });
      setStatusMessage('');
      return;
    }

    setError(null);
    setStatusMessage('');
    setPendingAction('verify');
    const request = beginRequest();

    try {
      const result = await verifyPhoneLoginAction(phone, code);
      if (!isCurrentRequest(request)) return;
      if (!result.ok) {
        setError(
          result.code === 'INVALID_SMS_CODE'
            ? { field: 'code', kind: 'server', message: '验证码错误' }
            : { field: 'form', kind: 'server', message: '暂时无法登录，请稍后重试' },
        );
        return;
      }
      setStatusMessage('登录成功，正在进入工作台。');
      const destination: WorkspaceDestination = '/studio';
      if (onAuthenticated) {
        onAuthenticated(destination);
      } else {
        globalThis.location.assign(destination);
      }
    } catch (verifyError) {
      if (!isCurrentRequest(request) || isAbortError(verifyError)) return;
      setError({ field: 'form', kind: 'server', message: '暂时无法登录，请稍后重试' });
    } finally {
      finishRequest(request);
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
          aria-describedby={error?.field === 'phone' ? `phone-help ${ERROR_ID}` : 'phone-help'}
          aria-invalid={error?.field === 'phone'}
          disabled={isBusy}
          onChange={(event) => {
            handlePhoneChange(event.target.value.replace(/\D/g, ''));
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
            aria-describedby={error?.field === 'code' ? ERROR_ID : undefined}
            aria-invalid={error?.field === 'code'}
            disabled={pendingAction === 'verify'}
            onChange={(event) => {
              handleCodeChange(event.target.value.replace(/\D/g, ''));
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
        <p
          ref={errorRef}
          id={ERROR_ID}
          className="form-feedback form-error"
          role="alert"
          tabIndex={-1}
        >
          {error.message}
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
