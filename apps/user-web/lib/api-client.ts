import { ApiErrorSchema, HEADERS, type ApiError } from '@repo/contracts/common';

const REQUEST_TIMEOUT_MS = 10_000;
const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export type GatewayPath = `/v1/${string}`;

interface BaseRequestOptions {
  body?: unknown;
  headers?: HeadersInit;
  signal?: AbortSignal;
}

type ReadRequestOptions = BaseRequestOptions & {
  idempotencyKey?: never;
  method?: 'GET' | 'HEAD';
};

type WriteRequestOptions = BaseRequestOptions & {
  idempotencyKey: string;
  method: 'DELETE' | 'PATCH' | 'POST' | 'PUT';
};

export type ApiClientOptions = ReadRequestOptions | WriteRequestOptions;

export interface ApiClientResponse<T> {
  data: T;
  headers: Headers;
  status: number;
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly details: ApiError['details'];
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly status: number;
  readonly traceId: string;

  constructor(error: ApiError, status: number, retryAfterSeconds?: number) {
    super(error.message);
    this.name = 'ApiClientError';
    this.code = error.code;
    this.details = error.details;
    this.retryable = error.retryable;
    this.retryAfterSeconds = retryAfterSeconds;
    this.status = status;
    this.traceId = error.traceId;
  }
}

function createTraceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function gatewayUrl(path: GatewayPath): string {
  const configuredGateway = process.env.NEXT_PUBLIC_GATEWAY_URL?.trim();
  const browserOrigin = typeof window === 'undefined' ? 'http://localhost' : window.location.origin;
  const baseUrl = configuredGateway || browserOrigin;
  return new URL(path, baseUrl).toString();
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) return undefined;
  return Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
}

async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205) return undefined;

  const text = await response.text();
  if (!text) return undefined;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function normalizeMethod(method: string | undefined): string {
  const normalizedMethod = (method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(normalizedMethod)) {
    throw new TypeError(`Unsupported Gateway request method: ${normalizedMethod}`);
  }
  return normalizedMethod;
}

export async function apiClient<T = undefined>(
  path: GatewayPath,
  options: ApiClientOptions = {},
): Promise<ApiClientResponse<T>> {
  const method = normalizeMethod(options.method);
  if (WRITE_METHODS.has(method)) {
    const key = 'idempotencyKey' in options ? options.idempotencyKey : undefined;
    if (!key || key.length < 16 || key.length > 128 || !/^[\x20-\x7e]+$/.test(key)) {
      throw new TypeError('Writes require a 16–128 character printable idempotency key.');
    }
  }

  const traceId = createTraceId();
  const headers = new Headers(options.headers);
  headers.set('accept', 'application/json');
  headers.set(HEADERS.traceId, traceId);
  headers.set(HEADERS.correlationId, crypto.randomUUID());
  if ('idempotencyKey' in options && options.idempotencyKey) {
    headers.set(HEADERS.idempotencyKey, options.idempotencyKey);
  }

  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(options.body);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort(new DOMException('The Gateway request timed out.', 'TimeoutError'));
  }, REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => {
    controller.abort(options.signal?.reason);
  };
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    const requestInit: RequestInit = {
      credentials: 'include',
      headers,
      method,
      signal: controller.signal,
    };
    if (body !== undefined) requestInit.body = body;
    const response = await fetch(gatewayUrl(path), requestInit);
    const payload = await responsePayload(response);

    if (!response.ok) {
      const parsedError = ApiErrorSchema.safeParse(payload);
      const error: ApiError = parsedError.success
        ? parsedError.data
        : {
            code: 'INVALID_API_ERROR',
            message: '请求暂时无法完成。',
            traceId,
            retryable: response.status >= 500,
          };
      throw new ApiClientError(
        error,
        response.status,
        parseRetryAfter(response.headers.get('retry-after')),
      );
    }

    return {
      data: payload as T,
      headers: response.headers,
      status: response.status,
    };
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
