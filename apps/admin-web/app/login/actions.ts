'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import {
  type ServerCookiePort,
  type TotpActionResult,
  createLoginActionHandlers,
} from '../../lib/admin-auth-actions';
import { createHttpAdminAuthPort } from '../../lib/http-admin-auth-port';
import type { PasswordStepResult } from '../../lib/login-flow';
import { publicPasswordStepResult } from '../../lib/login-flow';
import {
  defaultSafeTelemetry,
  recordSafeTelemetry,
} from '../../lib/safe-telemetry';

async function createHandlers() {
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
  });
}

export async function submitPasswordAction(
  _previousState: PasswordStepResult | null,
  formData: FormData,
): Promise<PasswordStepResult> {
  try {
    const handlers = await createHandlers();
    return await handlers.submitPassword(formData);
  } catch {
    recordSafeTelemetry(defaultSafeTelemetry, {
      operation: 'login.action',
      reason: 'ACTION_FAILURE',
    });
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
  } catch {
    recordSafeTelemetry(defaultSafeTelemetry, {
      operation: 'login.action',
      reason: 'ACTION_FAILURE',
    });
    return {
      status: 'INVALID_TOTP',
      message: '验证失败，请重试',
      cooldownSeconds: 0,
    };
  }
  if (result.status === 'AUTHENTICATED') {
    redirect(result.redirectTo);
  }

  return result;
}
