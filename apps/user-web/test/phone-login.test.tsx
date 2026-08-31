import '@testing-library/jest-dom/vitest';

import type { ApiError } from '@repo/contracts/common';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PhoneLoginForm } from '../components/auth/phone-login-form';

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

type GatewayHandler = (request: Request) => Response | undefined;

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

  return new Response(null, { status: 204 });
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

export const invalidCodeHandler: GatewayHandler = (request) => {
  if (request.method !== 'POST' || new URL(request.url).pathname !== '/v1/auth/sms/verify') {
    return undefined;
  }

  return Response.json(invalidCodeError, { status: 400 });
};

let handlers: GatewayHandler[] = [];

const gatewayMock = {
  use(handler: GatewayHandler) {
    handlers.unshift(handler);
  },
};

beforeEach(() => {
  handlers = [requestSmsHandler, verifySmsHandler];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      for (const handler of handlers) {
        const response = handler(request);
        if (response) return Promise.resolve(response);
      }
      return Promise.reject(
        new Error(`Unhandled Gateway request: ${request.method} ${request.url}`),
      );
    }),
  );
});

afterEach(() => {
  cleanup();
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

    expect(screen.getByRole('button', { name: /重新发送/ })).toBeDisabled();
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

  it('announces an invalid code without clearing the phone', async () => {
    const user = userEvent.setup();
    gatewayMock.use(invalidCodeHandler);

    render(<PhoneLoginForm />);
    const phoneInput = screen.getByLabelText('手机号');
    await user.type(phoneInput, '13800138000');
    await user.click(screen.getByRole('button', { name: '获取验证码' }));
    await user.type(screen.getByLabelText('短信验证码'), '000000');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('验证码错误');
    expect(phoneInput).toHaveValue('13800138000');
  });
});
