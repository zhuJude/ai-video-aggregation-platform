import { describe, expect, it } from 'vitest';
import { ApiErrorSchema } from '@repo/contracts/common';
import { PublicApiError, toApiError } from '../src/index.js';

describe('toApiError', () => {
  it('does not leak unknown error messages', () => {
    expect(toApiError(new Error('database password=secret'), 'a'.repeat(32))).toEqual({
      code: 'INTERNAL_ERROR',
      message: '系统暂时不可用',
      retryable: true,
      traceId: 'a'.repeat(32),
    });
  });

  it.each([
    { code: '23505', message: 'duplicate key value violates unique constraint users_email_key' },
    { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.2:5432' },
  ])('maps internal error code $code to a valid public error', (error) => {
    const result = toApiError(error, 'b'.repeat(32));

    expect(result).toEqual({
      code: 'INTERNAL_ERROR',
      message: '系统暂时不可用',
      retryable: true,
      traceId: 'b'.repeat(32),
    });
    expect(ApiErrorSchema.parse(result)).toEqual(result);
  });

  it('publishes only explicitly marked API errors', () => {
    const result = toApiError(
      new PublicApiError('QUOTE_EXPIRED', '报价已过期', false),
      'c'.repeat(32),
    );

    expect(result).toEqual({
      code: 'QUOTE_EXPIRED',
      message: '报价已过期',
      retryable: false,
      traceId: 'c'.repeat(32),
    });
    expect(ApiErrorSchema.parse(result)).toEqual(result);
  });
});
