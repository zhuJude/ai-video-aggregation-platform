export type ProviderFailure =
  | {
      readonly kind: 'HTTP';
      readonly status: number;
      readonly retryable: boolean;
      readonly ambiguous: false;
      readonly code:
        | 'PROVIDER_RATE_LIMITED'
        | 'PROVIDER_UNAVAILABLE'
        | 'PROVIDER_AUTH_FAILED'
        | 'PROVIDER_REJECTED';
      readonly retryAfterMs?: number;
    }
  | {
      readonly kind: 'TIMEOUT' | 'NETWORK';
      readonly retryable: true;
      readonly ambiguous: true;
      readonly code: 'PROVIDER_TIMEOUT' | 'PROVIDER_NETWORK_ERROR';
    }
  | {
      readonly kind: 'UNKNOWN';
      readonly retryable: false;
      readonly ambiguous: false;
      readonly code: 'PROVIDER_PROTOCOL_ERROR';
    };

const MAX_BACKOFF_MS = 300_000;
const NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

export function classifyHttpFailure(status: number, retryAfterSeconds?: number): ProviderFailure {
  const retryAfterMs = normalizeRetryAfter(retryAfterSeconds);
  if (status === 429) {
    return {
      kind: 'HTTP',
      status,
      retryable: true,
      ambiguous: false,
      code: 'PROVIDER_RATE_LIMITED',
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }
  if (status >= 500 && status <= 599) {
    return {
      kind: 'HTTP',
      status,
      retryable: true,
      ambiguous: false,
      code: 'PROVIDER_UNAVAILABLE',
    };
  }
  if (status === 401 || status === 403) {
    return {
      kind: 'HTTP',
      status,
      retryable: false,
      ambiguous: false,
      code: 'PROVIDER_AUTH_FAILED',
    };
  }
  return {
    kind: 'HTTP',
    status,
    retryable: false,
    ambiguous: false,
    code: 'PROVIDER_REJECTED',
  };
}

export function classifyProviderFailure(error: unknown): ProviderFailure {
  const record = asRecord(error);
  if (
    record !== undefined &&
    typeof record.status === 'number' &&
    Number.isInteger(record.status)
  ) {
    const retryAfterSeconds =
      typeof record.retryAfterSeconds === 'number' ? record.retryAfterSeconds : undefined;
    return classifyHttpFailure(record.status, retryAfterSeconds);
  }

  const name = error instanceof Error ? error.name : record?.name;
  const code = record?.code;
  if (name === 'AbortError' || (typeof code === 'string' && TIMEOUT_CODES.has(code))) {
    return {
      kind: 'TIMEOUT',
      retryable: true,
      ambiguous: true,
      code: 'PROVIDER_TIMEOUT',
    };
  }
  if (error instanceof TypeError || (typeof code === 'string' && NETWORK_CODES.has(code))) {
    return {
      kind: 'NETWORK',
      retryable: true,
      ambiguous: true,
      code: 'PROVIDER_NETWORK_ERROR',
    };
  }
  return {
    kind: 'UNKNOWN',
    retryable: false,
    ambiguous: false,
    code: 'PROVIDER_PROTOCOL_ERROR',
  };
}

export interface BackoffInput {
  readonly attempt: number;
  readonly retryAfterMs?: number;
  readonly jitterKey: string;
}

export function backoffMs(input: BackoffInput): number {
  const normalizedAttempt = Math.max(1, Math.trunc(input.attempt));
  const exponential = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(normalizedAttempt - 1, 9));
  const jitter = Math.trunc(
    exponential * 0.25 * deterministicUnit(input.jitterKey, normalizedAttempt),
  );
  const jitteredExponential = Math.min(MAX_BACKOFF_MS, exponential + jitter);
  const retryAfterMs = input.retryAfterMs ?? 0;
  const requested = Number.isFinite(retryAfterMs) ? Math.max(0, Math.trunc(retryAfterMs)) : 0;
  return Math.min(MAX_BACKOFF_MS, Math.max(jitteredExponential, requested));
}

function deterministicUnit(jitterKey: string, attempt: number): number {
  let hash = 0x811c9dc5;
  for (const character of `${jitterKey}:${String(attempt)}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) / 0x1_0000_0000;
}

function normalizeRetryAfter(seconds: number | undefined): number | undefined {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(MAX_BACKOFF_MS, Math.trunc(seconds * 1_000));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}
