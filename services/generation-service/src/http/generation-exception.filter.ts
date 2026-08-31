import { randomBytes } from 'node:crypto';
import {
  Catch,
  Inject,
  type ArgumentsHost,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
  Optional,
} from '@nestjs/common';
import { HEADERS } from '@repo/contracts/common';
import { GenerationApplicationError, type GenerationErrorCode } from '../application/errors.js';

const statusByCode: Record<GenerationErrorCode, number> = {
  INVALID_TASK_REQUEST: HttpStatus.BAD_REQUEST,
  INVALID_IDEMPOTENCY_KEY: HttpStatus.BAD_REQUEST,
  IDEMPOTENCY_CONFLICT: HttpStatus.CONFLICT,
  IDEMPOTENCY_IN_PROGRESS: HttpStatus.CONFLICT,
  QUOTE_NOT_FOUND: HttpStatus.NOT_FOUND,
  QUOTE_MISMATCH: HttpStatus.CONFLICT,
  QUOTE_EXPIRED: HttpStatus.CONFLICT,
  ROUTING_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  TASK_CREATION_FAILED: HttpStatus.SERVICE_UNAVAILABLE,
  TASK_CREATION_REPAIR_REQUIRED: HttpStatus.INTERNAL_SERVER_ERROR,
  REPAIR_PERSISTENCE_UNAVAILABLE: HttpStatus.SERVICE_UNAVAILABLE,
  TASK_NOT_FOUND: HttpStatus.NOT_FOUND,
  TASK_STATE_CONFLICT: HttpStatus.CONFLICT,
  INVALID_CURSOR: HttpStatus.BAD_REQUEST,
};

export function generationErrorStatus(error: GenerationApplicationError): number {
  return statusByCode[error.code];
}

interface HttpReply {
  status(code: number): { send(body: unknown): unknown };
}

interface HttpRequest {
  readonly headers?: Readonly<Record<string, unknown>>;
}

export interface GenerationExceptionLogger {
  error(message: string, trace?: string): void;
}

export const GENERATION_EXCEPTION_LOGGER = Symbol('GENERATION_EXCEPTION_LOGGER');

function requestTraceId(request: HttpRequest): string {
  const value = request.headers?.[HEADERS.traceId];
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
    ? value
    : randomBytes(16).toString('hex');
}

@Catch()
export class GenerationExceptionFilter implements ExceptionFilter {
  private readonly logger: GenerationExceptionLogger;

  constructor(
    @Optional()
    @Inject(GENERATION_EXCEPTION_LOGGER)
    logger?: GenerationExceptionLogger,
  ) {
    this.logger = logger ?? new Logger(GenerationExceptionFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const reply = http.getResponse<HttpReply>();
    const request = http.getRequest<HttpRequest>();
    if (exception instanceof GenerationApplicationError) {
      reply.status(generationErrorStatus(exception)).send({
        code: exception.code,
        message: exception.message,
        retryable: exception.retryable,
        traceId: requestTraceId(request),
      });
      return;
    }
    if (exception instanceof HttpException) {
      reply.status(exception.getStatus()).send(exception.getResponse());
      return;
    }
    const trace = requestTraceId(request);
    this.logger.error(
      `Unhandled generation HTTP exception traceId=${trace}`,
      exception instanceof Error ? exception.stack : String(exception),
    );
    reply.status(HttpStatus.INTERNAL_SERVER_ERROR).send({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      retryable: false,
      traceId: trace,
    });
  }
}
