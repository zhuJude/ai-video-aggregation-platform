'use client';

interface BrowserLockManager {
  request<T>(name: string, callback: () => T | PromiseLike<T>): Promise<T>;
}

let activeRefresh: Promise<boolean> | undefined;

async function postRefresh(): Promise<boolean> {
  const response = await fetch('/auth/refresh', {
    credentials: 'include',
    method: 'POST',
    signal: AbortSignal.timeout(10_000),
  });
  return response.status === 204;
}

async function refreshAfterStatusCheck(): Promise<boolean> {
  const status = await fetch('/auth/refresh', {
    credentials: 'include',
    method: 'GET',
    signal: AbortSignal.timeout(10_000),
  });
  if (status.status === 204) return true;
  if (status.status !== 401) return false;
  return postRefresh();
}

export function coordinateSessionRefresh(): Promise<boolean> {
  if (activeRefresh) return activeRefresh;
  const locks = (navigator as unknown as { readonly locks?: BrowserLockManager }).locks;
  if (!locks) return Promise.resolve(false);
  const refresh = Promise.resolve()
    .then(() => locks.request<boolean>('user-session-refresh', refreshAfterStatusCheck))
    .catch(() => false);
  activeRefresh = refresh;
  void refresh.then(() => {
    if (activeRefresh === refresh) activeRefresh = undefined;
  });
  return refresh;
}

export async function retryOnceAfterSessionRefresh<T>(
  operation: () => Promise<T>,
  isRefreshRequired: (result: T) => boolean | Promise<boolean>,
  discard?: (result: T) => void | Promise<void>,
): Promise<T> {
  const initial = await operation();
  if (!(await isRefreshRequired(initial))) return initial;
  const locks = (navigator as unknown as { readonly locks?: BrowserLockManager }).locks;
  if (!locks) return initial;
  try {
    const locked = await locks.request<{ readonly value: T }>('user-session-refresh', async () => {
      // Recheck after acquiring the cross-tab lock: another tab may already have rotated.
      const preflight = await operation();
      if (!(await isRefreshRequired(preflight))) return { value: preflight };
      if (!(await postRefresh())) return { value: preflight };
      await discard?.(preflight);
      return { value: await operation() };
    });
    await discard?.(initial);
    return locked.value;
  } catch {
    return initial;
  }
}

async function needsRefresh(response: Response): Promise<boolean> {
  if (response.status !== 401) return false;
  try {
    const body = (await response.clone().json()) as unknown;
    return (
      typeof body === 'object' &&
      body !== null &&
      !Array.isArray(body) &&
      Object.keys(body).length === 1 &&
      'code' in body &&
      body.code === 'SESSION_REFRESH_REQUIRED'
    );
  } catch {
    return false;
  }
}

export async function fetchWithSessionRefresh(request: () => Promise<Response>): Promise<Response> {
  return retryOnceAfterSessionRefresh(request, needsRefresh, async (response) => {
    await response.body?.cancel().catch(() => undefined);
  });
}
