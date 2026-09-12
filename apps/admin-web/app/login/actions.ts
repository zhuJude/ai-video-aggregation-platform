'use server';

import { cookies } from 'next/headers';

import {
  type ServerCookiePort,
  type TotpActionResult,
  createLoginActionHandlers,
} from '../../lib/admin-auth-actions';
import { createHttpAdminAuthPort } from '../../lib/http-admin-auth-port';
import type { PasswordStepResult } from '../../lib/login-flow';
import { publicPasswordStepResult } from '../../lib/login-flow';
import {
  consumeTechnicalFailure,
  createSafeTelemetryEvent,
  defaultSafeTelemetry,
  recordSafeTelemetry,
} from '../../lib/safe-telemetry';

function recordUnclassifiedActionFailure(error: unknown): void {
  if (consumeTechnicalFailure(error)) return;
  recordSafeTelemetry(defaultSafeTelemetry, createSafeTelemetryEvent('login.action', 'ACTION_FAILURE'));
}

async function createHandlers(redirectTo?: string) {
  const cookieStore = await cookies();
  const cookiePort: ServerCookiePort = {
    get(name) {
      return cookieStore.get(name)?.value;
    },
    set(name, value, options) {
      cookieStore.set(name, value, options);
    },
    delete(name) {
      cookieStore.delete(name);
    },
  };

  return createLoginActionHandlers({
    authPort: createHttpAdminAuthPort(),
    cookies: cookiePort,
    challengeSigningKey: process.env.ADMIN_MFA_CHALLENGE_SIGNING_KEY ?? '',
    sessionSigningKey: process.env.ADMIN_SESSION_SIGNING_KEY ?? '',
    requirePreflight: true,
    ...(redirectTo === undefined ? {} : { redirectTo }),
  });
}

export async function preparePasswordAction(identifier: string): Promise<Readonly<{ status: 'READY' | 'ERROR' }>> {
  try {
    return await (await createHandlers()).preparePassword(identifier);
  } catch (error) {
    recordUnclassifiedActionFailure(error);
    return { status: 'ERROR' };
  }
}

export async function submitPasswordAction(
  redirectTo: string,
  _previousState: PasswordStepResult | null,
  formData: FormData,
): Promise<PasswordStepResult> {
  try {
    const handlers = await createHandlers(redirectTo);
    return await handlers.submitPassword(formData);
  } catch (error) {
    recordUnclassifiedActionFailure(error);
    return publicPasswordStepResult();
  }
}

export async function submitTotpAction(
  _previousState: TotpActionResult | null,
  formData: FormData,
): Promise<TotpActionResult> {
  let result: TotpActionResult;
  try {
    const handlers = await createHandlers();
    result = await handlers.submitTotp(formData);
  } catch (error) {
    recordUnclassifiedActionFailure(error);
    return {
      status: 'INVALID_TOTP',
      message: '验证失败，请重试',
      cooldownSeconds: 0,
    };
  }
  return result;
}
