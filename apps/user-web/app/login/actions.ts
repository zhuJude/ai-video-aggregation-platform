'use server';

import { ApiErrorSchema, UuidSchema } from '@repo/contracts/common';

import {
  establishAuthenticatedServerSession,
  refreshTokenFromSetCookie,
} from '../../lib/auth/server-session';

export type VerifyPhoneLoginResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'INVALID_SMS_CODE' | 'LOGIN_UNAVAILABLE' };

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
    const gatewayUrl = process.env.GATEWAY_URL?.trim();
    if (!gatewayUrl) throw new Error('GATEWAY_URL_UNAVAILABLE');
    const response = await fetch(new URL('/v1/auth/sms/verify', gatewayUrl), {
      body: JSON.stringify({ code, deviceName: 'AI Video Web', phone }),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      method: 'POST',
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
    );
    return { ok: true };
  } catch {
    return { ok: false, code: 'LOGIN_UNAVAILABLE' };
  }
}
