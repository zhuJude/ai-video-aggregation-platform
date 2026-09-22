export const DEFAULT_UPSTREAM_DEADLINE_MS = 5_000;
export const MAX_UPSTREAM_DEADLINE_MS = 30_000;

export type HttpFailureReason = 'NETWORK_FAILURE' | 'TIMEOUT';

export class SafeHttpRequestError extends Error {
  readonly reason: HttpFailureReason;

  constructor(reason: HttpFailureReason) {
    super('Protected upstream request failed');
    this.name = 'SafeHttpRequestError';
    this.reason = reason;
  }
}

export function isValidDeadline(deadlineMs: number): boolean {
  return (
    Number.isInteger(deadlineMs) &&
    deadlineMs > 0 &&
    deadlineMs <= MAX_UPSTREAM_DEADLINE_MS
  );
}

export async function fetchWithDeadline<T>(
  fetchImpl: typeof fetch,
  input: URL,
  init: RequestInit,
  deadlineMs: number,
  consume: (response: Response, signal: AbortSignal) => Promise<T> | T,
): Promise<T> {
  const controller = new AbortController();
  let responseReceived = false;
  const timer = setTimeout(() => {
    controller.abort();
  }, deadlineMs);

  try {
    const response = await fetchImpl(input, {
      ...init,
      redirect: 'error',
      signal: controller.signal,
    });
    responseReceived = true;
    return await consume(response, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) {
      throw new SafeHttpRequestError('TIMEOUT');
    }
    if (!responseReceived) {
      throw new SafeHttpRequestError('NETWORK_FAILURE');
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
