import '@testing-library/jest-dom/vitest';

import type { ApiError } from '@repo/contracts/common';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhoneLoginForm } from '../components/auth/phone-login-form';
import { cancelTaskAction } from '../app/tasks/actions';

const LOGIN_OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6101';
const LOGIN_SESSION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a6111';
process.env.USER_WEB_SESSION_SIGNING_KEY = 'test-only-session-signing-key-32-bytes-minimum';
const encodeJwtSegment = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
const loginAccessToken = () =>
  `${encodeJwtSegment({ alg: 'ES256', typ: 'JWT' })}.${encodeJwtSegment({
    aud: 'user-web',
    exp: Math.floor(Date.now() / 1_000) + 900,
    iss: 'identity-service',
    sid: LOGIN_SESSION_ID,
    sub: LOGIN_OWNER_ID,
  })}.trusted-gateway-signature`;

const loginCookies = vi.hoisted(() => new Map<string, string>());
const loginCookieWrites = vi.hoisted(
  () => [] as Array<{ readonly name: string; readonly options: Record<string, unknown> }>,
);
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = loginCookies.get(name);
        return value ? { value } : undefined;
      },
      set: (name: string, value: string, options: Record<string, unknown>) => {
        loginCookies.set(name, value);
        loginCookieWrites.push({ name, options });
      },
    }),
}));

interface SmsRequestAccepted {
  message: string;
}

const smsRequestAccepted = {
  message: '如果该手机号可用，验证码将尽快发送。',
} satisfies SmsRequestAccepted;

const invalidCodeError = {
  code: 'INVALID_SMS_CODE',
  message: 'The verification code is invalid or expired.',
  traceId: '0123456789abcdef0123456789abcdef',
  retryable: false,
} satisfies ApiError;

type GatewayHandler = (request: Request) => Promise<Response> | Response | undefined;

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

function signalReason(signal: AbortSignal): unknown {
  return (signal as AbortSignal & { readonly reason?: unknown }).reason;
}

function settleGatewayResponse(
  request: Request,
  pendingResponse: Promise<Response> | Response,
): Promise<Response> {
  if (request.signal.aborted) {
    return Promise.reject(signalReason(request.signal) as Error);
  }

  return new Promise<Response>((resolve, reject) => {
    const abort = () => {
      reject(signalReason(request.signal) as Error);
    };
    request.signal.addEventListener('abort', abort, { once: true });
    void Promise.resolve(pendingResponse).then(
      (response) => {
        request.signal.removeEventListener('abort', abort);
        resolve(response);
      },
      (reason: unknown) => {
        request.signal.removeEventListener('abort', abort);
        reject(reason as Error);
      },
    );
  });
}

const requestSmsHandler: GatewayHandler = (request) => {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/auth/sms/request') {
    return undefined;
  }

  return Response.json(smsRequestAccepted, {
    status: 202,
    headers: { 'Retry-After': '60' },
  });
};

const verifySmsHandler: GatewayHandler = (request) => {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/auth/sms/verify') {
    return undefined;
  }

  return Response.json({ accessToken: loginAccessToken(), sessionId: LOGIN_SESSION_ID });
};

const retryAfterHandler: GatewayHandler = (request) => {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/auth/sms/request') {
    return undefined;
  }

  const responseBody = {
    code: 'SMS_RATE_LIMITED',
    message: 'Too many requests.',
    traceId: 'abcdef0123456789abcdef0123456789',
    retryable: true,
  } satisfies ApiError;
  return Response.json(responseBody, {
    status: 429,
    headers: { 'Retry-After': '90' },
  });
};

function createLongRetryAfterHandler(retryAfterSeconds: 301 | 600): GatewayHandler {
  return (request) => {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/auth/sms/request') {
      return undefined;
    }

    const responseBody = {
      code: 'SMS_RATE_LIMITED',
      message: 'Too many requests.',
      traceId: '1234567890abcdef1234567890abcdef',
      retryable: true,
    } satisfies ApiError;
    return Response.json(responseBody, {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    });
  };
}

export const invalidCodeHandler: GatewayHandler = (request) => {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/auth/sms/verify') {
    return undefined;
  }

  return Response.json(invalidCodeError, { status: 400 });
};

let handlers: GatewayHandler[] = [];
let gatewayRequests: Request[] = [];

const gatewayMock = {
  use(handler: GatewayHandler) {
    handlers.unshift(handler);
  },
};

beforeEach(() => {
  loginCookies.clear();
  loginCookieWrites.length = 0;
  handlers = [requestSmsHandler, verifySmsHandler];
  gatewayRequests = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      gatewayRequests.push(request);
      for (const handler of handlers) {
        const response = handler(request);
        if (response) return settleGatewayResponse(request, response);
      }
      return Promise.reject(
        new Error(`Unhandled Gateway request: ${request.method} ${request.url}`),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PhoneLoginForm', () => {
  it('validates the phone number and moves focus to it', async () => {
    const user = userEvent.setup();

    render(<PhoneLoginForm />);
    const phoneInput = screen.getByLabelText('手机号');
    await user.type(phoneInput, '1380013800');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('请输入 11 位手机号');
    expect(phoneInput).toHaveFocus();
  });

  it('prevents repeated SMS requests during cooldown', async () => {
    const user = userEvent.setup();

    render(<PhoneLoginForm />);
    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));

    const resendButton = screen.getByRole('button', { name: /重新发送/ });
    expect(resendButton).toBeDisabled();
    await user.click(resendButton);
    expect(
      gatewayRequests.filter((request) => new URL(request.url).pathname === '/v1/auth/sms/request'),
    ).toHaveLength(1);
  });

  it('does not issue a duplicate request while SMS delivery is pending', async () => {
    const user = userEvent.setup();
    const pendingSms = createDeferred<Response>();
    gatewayMock.use((request) =>
      new URL(request.url).pathname === '/v1/auth/sms/request' ? pendingSms.promise : undefined,
    );

    render(<PhoneLoginForm />);
    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    const pendingButton = screen.getByRole('button', { name: '正在发送……' });
    await user.click(pendingButton);

    expect(
      gatewayRequests.filter((request) => new URL(request.url).pathname === '/v1/auth/sms/request'),
    ).toHaveLength(1);

    await act(() => {
      pendingSms.resolve(
        Response.json(smsRequestAccepted, {
          status: 202,
          headers: { 'Retry-After': '60' },
        }),
      );
      return Promise.resolve();
    });
  });

  it('does not attach an old SMS challenge to a changed phone', async () => {
    const user = userEvent.setup();
    const pendingSms = createDeferred<Response>();
    gatewayMock.use((request) =>
      new URL(request.url).pathname === '/v1/auth/sms/request' ? pendingSms.promise : undefined,
    );

    render(<PhoneLoginForm />);
    const phoneInput = screen.getByLabelText('手机号');
    await user.type(phoneInput, '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(phoneInput).toBeDisabled();
    expect(phoneInput).toHaveValue('13800138000');

    await act(() => {
      pendingSms.resolve(
        Response.json(smsRequestAccepted, {
          status: 202,
          headers: { 'Retry-After': '60' },
        }),
      );
      return Promise.resolve();
    });
    expect(await screen.findByRole('button', { name: /重新发送/ })).toBeDisabled();

    await user.clear(phoneInput);
    await user.type(phoneInput, '13900139000');
    expect(screen.getByRole('button', { name: '获取验证码' })).toBeEnabled();
    expect(screen.queryByText(smsRequestAccepted.message)).not.toBeInTheDocument();
  });

  it('honors a longer Gateway Retry-After cooldown', async () => {
    const user = userEvent.setup();
    gatewayMock.use(retryAfterHandler);

    render(<PhoneLoginForm />);
    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));

    expect(screen.getByRole('button', { name: /重新发送（90 秒）/ })).toBeDisabled();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '请稍后重试，我们不会透露该手机号是否已注册。',
    );
  });

  it.each([
    [301, 1],
    [600, 300],
  ] as const)(
    'honors the full %i-second Gateway Retry-After window past five minutes',
    async (retryAfterSeconds, remainingAfterFiveMinutes) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
      gatewayMock.use(createLongRetryAfterHandler(retryAfterSeconds));

      render(<PhoneLoginForm />);
      fireEvent.change(screen.getByLabelText('手机号'), { target: { value: '13800138000' } });
      fireEvent.click(screen.getByRole('button', { name: '获取验证码' }));

      await act(() => Promise.resolve());

      expect(
        screen.getByRole('button', { name: `重新发送（${String(retryAfterSeconds)} 秒）` }),
      ).toBeDisabled();

      await act(() => vi.advanceTimersByTimeAsync(300_000));

      expect(
        screen.getByRole('button', {
          name: `重新发送（${String(remainingAfterFiveMinutes)} 秒）`,
        }),
      ).toBeDisabled();
    },
  );

  it('announces an invalid code without clearing the phone', async () => {
    const user = userEvent.setup();
    gatewayMock.use(invalidCodeHandler);

    render(<PhoneLoginForm />);
    const phoneInput = screen.getByLabelText('手机号');
    await user.type(phoneInput, '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    const codeInput = screen.getByLabelText('短信验证码');
    await user.type(codeInput, '000000');
    await user.click(screen.getByRole('button', { name: '登录' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('验证码错误');
    expect(alert).toHaveAttribute('id', 'phone-login-error');
    expect(codeInput).toHaveAttribute('aria-invalid', 'true');
    expect(codeInput).toHaveAttribute('aria-describedby', 'phone-login-error');
    expect(phoneInput).toHaveValue('13800138000');

    await user.clear(codeInput);
    await user.type(codeInput, '1');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(codeInput).toHaveAttribute('aria-invalid', 'false');
    expect(codeInput).not.toHaveAttribute('aria-describedby');

    await user.clear(codeInput);
    await user.type(codeInput, '000000');
    await user.click(screen.getByRole('button', { name: '登录' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('验证码错误');

    await user.clear(phoneInput);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(codeInput).toHaveValue('');
  });

  it('does not complete login after unmounting during verification', async () => {
    const user = userEvent.setup();
    const pendingVerification = createDeferred<Response>();
    const onAuthenticated = vi.fn();
    gatewayMock.use((request) =>
      new URL(request.url).pathname === '/v1/auth/sms/verify'
        ? pendingVerification.promise
        : undefined,
    );

    const { unmount } = render(<PhoneLoginForm onAuthenticated={onAuthenticated} />);
    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    await user.type(screen.getByLabelText('短信验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '登录' }));

    unmount();
    await act(() => {
      pendingVerification.resolve(new Response(null, { status: 204 }));
      return Promise.resolve();
    });

    expect(onAuthenticated).not.toHaveBeenCalled();
  });

  it('redirects a successful login to the studio workspace', async () => {
    const user = userEvent.setup();
    const onAuthenticated = vi.fn();

    render(<PhoneLoginForm onAuthenticated={onAuthenticated} />);
    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    await user.type(screen.getByLabelText('短信验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(onAuthenticated).toHaveBeenCalledWith('/studio');
  });

  it('establishes a signed HttpOnly app session after Gateway verification', async () => {
    const user = userEvent.setup();
    render(<PhoneLoginForm onAuthenticated={vi.fn()} />);
    await user.type(screen.getByLabelText('手机号'), '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    await user.type(screen.getByLabelText('短信验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(loginCookies.get('__Host-user-session')).toMatch(/^[^.]+\.[A-Za-z0-9_-]+$/);
    expect(loginCookieWrites.at(-1)).toMatchObject({
      name: '__Host-user-session',
      options: { httpOnly: true, path: '/', sameSite: 'lax', secure: true },
    });
    await expect(
      cancelTaskAction('task-1', '0198f4d4-21c2-7b7d-8a03-08a0da2a6301'),
    ).resolves.toMatchObject({ ok: true });
  });
});
