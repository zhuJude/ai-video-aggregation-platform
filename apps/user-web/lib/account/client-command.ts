'use client';

import { coordinateSessionRefresh } from '../auth/client-session';
import type { AccountActionResult } from './types';

export type RecoveredAccountActionResult<T> =
  AccountActionResult<T> | { readonly ok: false; readonly outcome: 'LOGIN_REQUIRED' };

export async function runAccountActionWithRefresh<T>(
  idempotencyKey: string,
  operation: (idempotencyKey: string) => Promise<AccountActionResult<T>>,
): Promise<RecoveredAccountActionResult<T>> {
  const initial = await operation(idempotencyKey);
  if (initial.ok || initial.outcome !== 'SESSION_REFRESH_REQUIRED') return initial;
  if (!(await coordinateSessionRefresh())) return { ok: false, outcome: 'LOGIN_REQUIRED' };
  const retried = await operation(idempotencyKey);
  return !retried.ok && retried.outcome === 'SESSION_REFRESH_REQUIRED'
    ? { ok: false, outcome: 'LOGIN_REQUIRED' }
    : retried;
}
