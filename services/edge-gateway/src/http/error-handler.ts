import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
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
  INVALID_IDEMPOTENCY_KEY: 400,
  NOT_FOUND: 404,
  RATE_LIMITED: 429,
  RATE_LIMIT_UNAVAILABLE: 503,
  SERVICE_TIMEOUT: 504,
  SSE_CONNECTION_LIMIT: 429,
  UPSTREAM_ERROR: 502,
  UPSTREAM_UNAVAILABLE: 503,
};

function requestTraceId(request: FastifyRequest): string {
  const value = request.headers[HEADERS.traceId];
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
    ? value
    : '0'.repeat(32);
}

@Catch()
export class GatewayErrorFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const body = toApiError(error, requestTraceId(request));
    const statusCode =
      error instanceof PublicApiError ? (PUBLIC_ERROR_STATUSES[error.code] ?? 400) : 500;

    void reply.status(statusCode).type('application/json').send(body);
  }
}
