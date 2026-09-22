'use client';

import { coordinateSessionRefresh } from '../auth/client-session';

type CommerceActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | {
      readonly ok: false;
      readonly outcome: 'DEFINITIVE_FAILURE' | 'UNCERTAIN' | 'SESSION_REFRESH_REQUIRED';
    };

export type RecoveredCommerceActionResult<T> =
  CommerceActionResult<T> | { readonly ok: false; readonly outcome: 'LOGIN_REQUIRED' };

export async function runCommerceActionWithRefresh<T>(
  operation: () => Promise<CommerceActionResult<T>>,
): Promise<RecoveredCommerceActionResult<T>> {
  const initial = await operation();
  if (initial.ok || initial.outcome !== 'SESSION_REFRESH_REQUIRED') return initial;
  if (!(await coordinateSessionRefresh())) return { ok: false, outcome: 'LOGIN_REQUIRED' };
  const retried = await operation();
  return !retried.ok && retried.outcome === 'SESSION_REFRESH_REQUIRED'
    ? { ok: false, outcome: 'LOGIN_REQUIRED' }
    : retried;
}
