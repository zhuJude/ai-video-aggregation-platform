import { ApiErrorSchema, type ApiError } from '@repo/contracts/common';

export class PublicApiError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, retryable = false, details?: Record<string, unknown>) {
    super(ApiErrorSchema.shape.message.parse(message));
    this.name = 'PublicApiError';
    this.code = ApiErrorSchema.shape.code.parse(code);
    this.retryable = retryable;
    this.details = details;
  }
}

export function toApiError(error: unknown, traceId: string): ApiError {
  if (error instanceof PublicApiError) {
    return ApiErrorSchema.parse({
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      traceId,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }

  return ApiErrorSchema.parse({
    code: 'INTERNAL_ERROR',
    message: '系统暂时不可用',
    retryable: true,
    traceId,
  });
}
