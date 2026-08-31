import type { ApiError } from '@repo/contracts/common';

export function toApiError(error: unknown, traceId: string): ApiError {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return {
      code: error.code,
      message: '请求无法完成',
      retryable: false,
      traceId,
    };
  }

  return {
    code: 'INTERNAL_ERROR',
    message: '系统暂时不可用',
    retryable: true,
    traceId,
  };
}
