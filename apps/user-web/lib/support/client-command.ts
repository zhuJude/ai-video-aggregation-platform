'use client';

import { coordinateSessionRefresh } from '../auth/client-session';
import type { SupportActionResult } from './types';

export async function runSupportActionWithRefresh<T>(
  idempotencyKey: string,
  operation: (idempotencyKey: string) => Promise<SupportActionResult<T>>,
): Promise<SupportActionResult<T> | { readonly ok: false; readonly outcome: 'LOGIN_REQUIRED' }> {
  const initial = await operation(idempotencyKey);
  if (initial.ok || initial.outcome !== 'SESSION_REFRESH_REQUIRED') return initial;
  if (!(await coordinateSessionRefresh())) return { ok: false, outcome: 'LOGIN_REQUIRED' };
  const retried = await operation(idempotencyKey);
  return !retried.ok && retried.outcome === 'SESSION_REFRESH_REQUIRED'
    ? { ok: false, outcome: 'LOGIN_REQUIRED' }
    : retried;
}
