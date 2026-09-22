import { Catch, HttpException, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import { HEADERS } from '@repo/contracts/common';
import { PublicApiError, toApiError } from '@repo/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';

const PUBLIC_ERROR_STATUSES: Readonly<Record<string, number>> = {
  BAD_REQUEST: 400,
  CIRCUIT_OPEN: 503,
  FORBIDDEN: 403,
  IDEMPOTENCY_CONFLICT: 409,
  IDEMPOTENCY_REQUIRED: 400,
  IDEMPOTENCY_UNAVAILABLE: 503,
  INVALID_ADMIN_TOKEN: 401,
  INVALID_IDEMPOTENCY_KEY: 400,
  INVALID_USER_TOKEN: 401,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  RATE_LIMIT_UNAVAILABLE: 503,
  SERVICE_TIMEOUT: 504,
  SSE_CONNECTION_LIMIT: 429,
  UPSTREAM_ERROR: 502,
  UPSTREAM_UNAVAILABLE: 503,
};

function requestTraceId(request: FastifyRequest): string {
  const value = request.headers[HEADERS.traceId];
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : '0'.repeat(32);
}

@Catch()
export class GatewayErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    sendGatewayError(error, request, reply);
  }
}

export function sendGatewayError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
): void {
  const normalizedError = normalizeFrameworkError(error);
  const body = toApiError(normalizedError, requestTraceId(request));
  const statusCode =
    normalizedError instanceof PublicApiError
      ? (PUBLIC_ERROR_STATUSES[normalizedError.code] ?? 400)
      : 500;
  void reply.status(statusCode).type('application/json').send(body);
}

function normalizeFrameworkError(error: unknown): unknown {
  if (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  ) {
    return new PublicApiError('PAYLOAD_TOO_LARGE', '请求体超过大小限制', false);
  }
  if (error instanceof HttpException) {
    const status = error.getStatus();
    if (status === 404) return new PublicApiError('NOT_FOUND', '请求的资源不存在', false);
    if (status === 413) {
      return new PublicApiError('PAYLOAD_TOO_LARGE', '请求体超过大小限制', false);
    }
    if (status >= 400 && status < 500) {
      return new PublicApiError('BAD_REQUEST', '请求无法处理', false);
    }
  }
  return error;
}
