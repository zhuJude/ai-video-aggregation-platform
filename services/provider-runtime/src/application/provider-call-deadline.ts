export interface ProviderCallTimers {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export class ProviderCallTimeoutError extends Error {
  readonly code = 'ETIMEDOUT';

  constructor() {
    super('PROVIDER_CALL_TIMEOUT');
    this.name = 'ProviderCallTimeoutError';
  }
}

export type ProviderCallDeadlineResult<T> =
  | { readonly kind: 'RESULT'; readonly result: T }
  | { readonly kind: 'TIMED_OUT'; readonly operation: Promise<T> };

export async function callProviderWithDeadline<T>(input: {
  readonly operation: () => Promise<T>;
  readonly timeoutMs: number;
  readonly timers: ProviderCallTimers;
}): Promise<ProviderCallDeadlineResult<T>> {
  const operation = Promise.resolve().then(input.operation);
  let timer: unknown;
  const deadline = new Promise<{ readonly kind: 'TIMED_OUT' }>((resolve) => {
    timer = input.timers.set(() => {
      resolve({ kind: 'TIMED_OUT' });
    }, input.timeoutMs);
  });
  try {
    const raced = await Promise.race([
      operation.then((result) => ({ kind: 'RESULT' as const, result })),
      deadline,
    ]);
    return raced.kind === 'RESULT' ? raced : { ...raced, operation };
  } finally {
    input.timers.clear(timer);
  }
}

export function defaultProviderCallTimers(): ProviderCallTimers {
  return {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  };
}
