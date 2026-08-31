import { Agent, request as undiciRequest } from 'undici';
import { PublicApiError } from '@repo/service-kit';

export type ServiceMethod = 'DELETE' | 'GET' | 'HEAD' | 'PATCH' | 'POST' | 'PUT';

export interface ServiceRequestContext {
  readonly correlationId: string;
  readonly subjectAssertion: string;
  readonly traceId: string;
}

export interface ServiceTransportRequest {
  readonly body?: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: ServiceMethod;
  readonly url: string;
}

export interface ServiceTransportResponse {
  readonly body: unknown;
  readonly statusCode: number;
}

export interface ServiceTransport {
  (request: ServiceTransportRequest): Promise<ServiceTransportResponse>;
  close?(): Promise<void>;
}

export interface ServiceClientOptions {
  readonly baseUrl: string;
  readonly circuitFailureThreshold?: number;
  readonly circuitResetMs?: number;
  readonly requestTimeoutMs?: number;
  readonly onCircuitOpen?: () => void;
  readonly onTimeout?: () => void;
  readonly transport?: ServiceTransport;
}

export interface ServiceRequest {
  readonly body?: unknown;
  readonly context: ServiceRequestContext;
  readonly idempotencyKey?: string;
  readonly method: ServiceMethod;
  readonly path: string;
}

class RequestTimeoutError extends Error {
  constructor() {
    super('service request timeout');
    this.name = 'RequestTimeoutError';
  }
}

function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new RequestTimeoutError());
    }, timeoutMs);
    void operation
      .then(
        (value) => {
          resolve(value);
        },
        (error: unknown) => {
          reject(error instanceof Error ? error : new Error('unknown service transport error'));
        },
      )
      .finally(() => {
        clearTimeout(timer);
      });
  });
}

function createUndiciTransport(): ServiceTransport {
  const dispatcher = new Agent({ connectTimeout: 500 });
  const transport: ServiceTransport = async (input) => {
    const response = await undiciRequest(input.url, {
      ...(input.body === undefined ? {} : { body: input.body }),
      bodyTimeout: 2_000,
      dispatcher,
      headers: input.headers,
      headersTimeout: 2_000,
      method: input.method,
    });
    const text = await response.body.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text) as unknown;
      } catch {
        body = text;
      }
    }
    return { body, statusCode: response.statusCode };
  };
  transport.close = () => dispatcher.destroy();
  return transport;
}

export class ServiceClient {
  private readonly baseUrl: URL;
  private readonly failureThreshold: number;
  private readonly resetMs: number;
  private readonly requestTimeoutMs: number;
  private readonly onCircuitOpen: () => void;
  private readonly onTimeout: () => void;
  private readonly transport: ServiceTransport;
  private consecutiveFailures = 0;
  private openedAt: number | undefined;

  constructor(options: ServiceClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    this.failureThreshold = options.circuitFailureThreshold ?? 5;
    this.resetMs = options.circuitResetMs ?? 30_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 2_000;
    this.onCircuitOpen = options.onCircuitOpen ?? (() => undefined);
    this.onTimeout = options.onTimeout ?? (() => undefined);
    this.transport = options.transport ?? createUndiciTransport();
  }

  async request<TResponse>(input: ServiceRequest): Promise<TResponse> {
    if (this.openedAt !== undefined && Date.now() - this.openedAt < this.resetMs) {
      throw new PublicApiError('CIRCUIT_OPEN', '依赖服务暂时不可用', true);
    }
    if (this.openedAt !== undefined) {
      this.openedAt = undefined;
      this.consecutiveFailures = 0;
    }

    const attempts = input.method === 'GET' || input.method === 'HEAD' ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await withTimeout(
          this.transport({
            ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
            headers: {
              authorization: `Bearer ${input.context.subjectAssertion}`,
              ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
              ...(input.idempotencyKey === undefined
                ? {}
                : { 'idempotency-key': input.idempotencyKey }),
              'x-correlation-id': input.context.correlationId,
              'x-trace-id': input.context.traceId,
            },
            method: input.method,
            url: new URL(input.path, this.baseUrl).toString(),
          }),
          this.requestTimeoutMs,
        );
        if (response.statusCode < 200 || response.statusCode >= 300) {
          throw new PublicApiError(
            'UPSTREAM_ERROR',
            '依赖服务返回错误',
            response.statusCode === 429 || response.statusCode >= 500,
          );
        }
        this.consecutiveFailures = 0;
        return response.body as TResponse;
      } catch (error) {
        lastError = error;
        const retryable = !(error instanceof PublicApiError) || error.retryable;
        if (!retryable || attempt + 1 >= attempts) break;
      }
    }

    if (lastError instanceof PublicApiError && !lastError.retryable) {
      this.consecutiveFailures = 0;
      throw lastError;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.openedAt = Date.now();
      this.onCircuitOpen();
    }
    if (lastError instanceof RequestTimeoutError) {
      this.onTimeout();
      throw new PublicApiError('SERVICE_TIMEOUT', '依赖服务响应超时', true);
    }
    if (lastError instanceof PublicApiError) {
      throw lastError;
    }
    throw new PublicApiError('UPSTREAM_UNAVAILABLE', '依赖服务暂时不可用', true);
  }

  async close(): Promise<void> {
    await this.transport.close?.();
  }
}
