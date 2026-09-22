'use server';

import { ApiErrorSchema, UuidSchema } from '@repo/contracts/common';

import {
  establishAuthenticatedServerSession,
  refreshTokenFromSetCookie,
} from '../../lib/auth/server-session';
import { cookies } from 'next/headers';
import { randomBytes } from 'node:crypto';

const DEVICE_COOKIE = '__Host-user-device';
const DEVICE_NAME = 'AI Video Web';

export type VerifyPhoneLoginResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'INVALID_SMS_CODE' | 'LOGIN_UNAVAILABLE' };

export type RequestPhoneLoginResult =
  | { readonly ok: true; readonly cooldownSeconds: number }
  | { readonly ok: false; readonly cooldownSeconds?: number };

async function trustedDeviceId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(DEVICE_COOKIE)?.value;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const created = randomBytes(16).toString('hex');
  jar.set(DEVICE_COOKIE, created, {
    httpOnly: true,
    maxAge: 365 * 24 * 60 * 60,
    path: '/',
    sameSite: 'lax',
    secure: true,
  });
  return created;
}

function gatewayUrl(path: `/v1/${string}`): URL {
  const configured = process.env.GATEWAY_URL?.trim();
  if (!configured) throw new Error('GATEWAY_URL_UNAVAILABLE');
  return new URL(path, configured);
}

function authHeaders(): Headers {
  return new Headers({
    accept: 'application/json',
    'content-type': 'application/json',
    'x-correlation-id': crypto.randomUUID(),
    'x-trace-id': randomBytes(16).toString('hex'),
  });
}

export async function requestPhoneLoginCodeAction(phone: string): Promise<RequestPhoneLoginResult> {
  if (!/^1\d{10}$/.test(phone)) return { ok: false };
  try {
    const response = await fetch(gatewayUrl('/v1/auth/sms/request'), {
      body: JSON.stringify({ deviceId: await trustedDeviceId(), phone }),
      headers: authHeaders(),
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    const retryAfter = Number(response.headers.get('retry-after'));
    const cooldownSeconds = Number.isSafeInteger(retryAfter) && retryAfter > 0 ? retryAfter : 60;
    return response.ok ? { ok: true, cooldownSeconds } : { ok: false, cooldownSeconds };
  } catch {
    return { ok: false };
  }
}

function parseGatewayLogin(value: unknown): {
  readonly accessToken: string;
  readonly sessionId: string;
} {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('INVALID_LOGIN_RESPONSE');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== 'accessToken' && key !== 'sessionId') ||
    typeof record.accessToken !== 'string'
  ) {
    throw new Error('INVALID_LOGIN_RESPONSE');
  }
  const sessionId = UuidSchema.safeParse(record.sessionId);
  if (!sessionId.success) throw new Error('INVALID_LOGIN_RESPONSE');
  return { accessToken: record.accessToken, sessionId: sessionId.data };
}

export async function verifyPhoneLoginAction(
  phone: string,
  code: string,
): Promise<VerifyPhoneLoginResult> {
  if (!/^1\d{10}$/.test(phone) || !/^\d{6}$/.test(code)) {
    return { ok: false, code: 'INVALID_SMS_CODE' };
  }
  try {
    const deviceId = await trustedDeviceId();
    const response = await fetch(gatewayUrl('/v1/auth/sms/verify'), {
      body: JSON.stringify({ code, deviceName: `${DEVICE_NAME} ${deviceId.slice(0, 12)}`, phone }),
      headers: authHeaders(),
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    const payload = (await response.json()) as unknown;
    if (!response.ok) {
      const parsed = ApiErrorSchema.safeParse(payload);
      const invalidCode =
        parsed.success &&
        ['INVALID_SMS_CODE', 'SMS_CHALLENGE_LOCKED', 'SMS_CODE_EXPIRED'].includes(parsed.data.code);
      return { ok: false, code: invalidCode ? 'INVALID_SMS_CODE' : 'LOGIN_UNAVAILABLE' };
    }
    const session = parseGatewayLogin(payload);
    await establishAuthenticatedServerSession(
      session.accessToken,
      session.sessionId,
      refreshTokenFromSetCookie(response.headers.get('set-cookie')),
      `+86${phone}`,
    );
    return { ok: true };
  } catch {
    return { ok: false, code: 'LOGIN_UNAVAILABLE' };
  }
}
