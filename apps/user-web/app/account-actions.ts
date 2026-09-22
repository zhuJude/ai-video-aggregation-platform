'use server';

import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';

import {
  AuthenticationRequiredError,
  clearAuthenticatedServerSession,
  replaceAuthenticatedServerSessionPhone,
  requireMutableAuthenticatedServerSessionIdentity,
  SessionRefreshRequiredError,
} from '../lib/auth/server-session';
import { accountGateway, AccountGatewayError } from '../lib/account/gateway';
import { parseProfile, parseSecuritySessions } from '../lib/account/runtime';
import type {
  AccountActionResult,
  PhoneCodeRequestResult,
  ProfileView,
  SecuritySessionView,
} from '../lib/account/types';

const DEVICE_COOKIE = '__Host-user-device';

function failure(error: unknown): AccountActionResult<never> {
  if (error instanceof SessionRefreshRequiredError)
    return { ok: false, outcome: 'SESSION_REFRESH_REQUIRED' };
  if (error instanceof AuthenticationRequiredError)
    return { ok: false, outcome: 'DEFINITIVE_FAILURE' };
  if (error instanceof AccountGatewayError) {
    return {
      ok: false,
      outcome: 'DEFINITIVE_FAILURE',
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    };
  }
  return { ok: false, outcome: 'UNCERTAIN' };
}

async function context(idempotencyKey?: string) {
  const session = await requireMutableAuthenticatedServerSessionIdentity();
  return {
    ownerId: session.ownerId,
    currentSessionId: session.sessionId,
    verifiedPhone: session.verifiedPhone,
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };
}

async function deviceId(): Promise<string> {
  const jar = await cookies();
  const existing = jar.get(DEVICE_COOKIE)?.value;
  if (existing && /^[a-f0-9]{32}$/.test(existing)) return existing;
  const created = randomBytes(16).toString('hex');
  jar.set(DEVICE_COOKIE, created, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 365 * 24 * 60 * 60,
  });
  return created;
}

export async function updateProfileAction(
  input: {
    readonly nickname: string;
    readonly avatarPreset: ProfileView['avatarPreset'];
    readonly avatarAssetId?: string;
  },
  idempotencyKey: string,
): Promise<AccountActionResult<ProfileView>> {
  try {
    return {
      ok: true,
      data: parseProfile(
        await accountGateway.updateProfile(
          input,
          (await context(idempotencyKey)) as Awaited<ReturnType<typeof context>> & {
            idempotencyKey: string;
          },
        ),
      ),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function requestAccountDeletionCodeAction(
  idempotencyKey: string,
): Promise<AccountActionResult<PhoneCodeRequestResult>> {
  try {
    const result = await accountGateway.requestAccountDeletionCode(
      { deviceId: await deviceId() },
      (await context(idempotencyKey)) as Awaited<ReturnType<typeof context>> & {
        idempotencyKey: string;
      },
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('cooldownSeconds' in result) ||
      !Number.isSafeInteger(result.cooldownSeconds) ||
      !('message' in result) ||
      result.message !== '如果账号可操作，验证码将尽快发送。'
    )
      throw new Error('INVALID_DELETE_REQUEST_RESULT');
    return {
      ok: true,
      data: { cooldownSeconds: result.cooldownSeconds as number, message: result.message },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function revokeSessionAction(
  handle: string,
  idempotencyKey: string,
): Promise<AccountActionResult<{ readonly revoked: true }>> {
  try {
    const result = await accountGateway.revokeSession(
      handle,
      (await context(idempotencyKey)) as Awaited<ReturnType<typeof context>> & {
        idempotencyKey: string;
      },
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('revoked' in result) ||
      result.revoked !== true
    )
      throw new Error('INVALID_REVOKE_RESULT');
    return { ok: true, data: { revoked: true } };
  } catch (error) {
    return failure(error);
  }
}

export async function exitAllSessionsAction(
  idempotencyKey: string,
): Promise<AccountActionResult<{ readonly signedOut: true }>> {
  try {
    const result = await accountGateway.exitAll(
      (await context(idempotencyKey)) as Awaited<ReturnType<typeof context>> & {
        idempotencyKey: string;
      },
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('signedOut' in result) ||
      result.signedOut !== true
    )
      throw new Error('INVALID_EXIT_RESULT');
    await clearAuthenticatedServerSession();
    return { ok: true, data: { signedOut: true } };
  } catch (error) {
    return failure(error);
  }
}

export async function requestPhoneChangeCodesAction(
  newPhoneE164: string,
  idempotencyKey: string,
): Promise<AccountActionResult<PhoneCodeRequestResult>> {
  try {
    const result = await accountGateway.requestPhoneChangeCodes(
      { newPhoneE164, deviceId: await deviceId() },
      (await context(idempotencyKey)) as Awaited<ReturnType<typeof context>> & {
        idempotencyKey: string;
      },
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('cooldownSeconds' in result) ||
      !Number.isSafeInteger(result.cooldownSeconds) ||
      !('message' in result) ||
      result.message !== '如果手机号可用，验证码将尽快发送。'
    )
      throw new Error('INVALID_PHONE_REQUEST_RESULT');
    return {
      ok: true,
      data: { cooldownSeconds: result.cooldownSeconds as number, message: result.message },
    };
  } catch (error) {
    return failure(error);
  }
}

export async function verifyPhoneChangeAction(
  input: {
    readonly currentPhoneCode: string;
    readonly newPhoneE164: string;
    readonly newPhoneCode: string;
  },
  operationId: string,
): Promise<AccountActionResult<{ readonly changed: true }>> {
  try {
    const commandContext = (await context(operationId)) as Awaited<ReturnType<typeof context>> & {
      idempotencyKey: string;
    };
    const result = await accountGateway.verifyPhoneChange(
      { ...input, operationId },
      commandContext,
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('changed' in result) ||
      result.changed !== true ||
      !('verifiedPhone' in result) ||
      typeof result.verifiedPhone !== 'string'
    )
      throw new Error('INVALID_PHONE_VERIFY_RESULT');
    await replaceAuthenticatedServerSessionPhone(commandContext.ownerId, result.verifiedPhone);
    return { ok: true, data: { changed: true } };
  } catch (error) {
    return failure(error);
  }
}

export async function closeAccountAction(
  code: string,
  operationId: string,
): Promise<AccountActionResult<{ readonly closed: true }>> {
  try {
    const result = await accountGateway.closeAccount(
      { code, operationId },
      (await context(operationId)) as Awaited<ReturnType<typeof context>> & {
        idempotencyKey: string;
      },
    );
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('closed' in result) ||
      result.closed !== true
    )
      throw new Error('INVALID_CLOSE_RESULT');
    await clearAuthenticatedServerSession();
    return { ok: true, data: { closed: true } };
  } catch (error) {
    return failure(error);
  }
}

export async function listSecuritySessionsAction(): Promise<
  AccountActionResult<readonly SecuritySessionView[]>
> {
  try {
    return {
      ok: true,
      data: parseSecuritySessions(await accountGateway.listSessions(await context())),
    };
  } catch (error) {
    return failure(error);
  }
}
