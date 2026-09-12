'use server';

import { UuidSchema } from '@repo/contracts/common';

import { establishAuthenticatedServerSession } from '../../lib/auth/server-session';
import { ApiClientError, apiClient } from '../../lib/api-client';
import { createUuidV7 } from '../../lib/tasks/identifiers';

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
    const response = await apiClient<unknown>('/v1/auth/sms/verify', {
      body: { code, phone },
      idempotencyKey: `sms-verify-${createUuidV7()}`,
      method: 'POST',
    });
    const session = parseGatewayLogin(response.data);
    await establishAuthenticatedServerSession(session.accessToken, session.sessionId);
    return { ok: true };
  } catch (error) {
    const invalidCode =
      error instanceof ApiClientError &&
      ['INVALID_SMS_CODE', 'SMS_CHALLENGE_LOCKED', 'SMS_CODE_EXPIRED'].includes(error.code);
    return { ok: false, code: invalidCode ? 'INVALID_SMS_CODE' : 'LOGIN_UNAVAILABLE' };
  }
}
