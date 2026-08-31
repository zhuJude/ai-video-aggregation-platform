import { describe, expect, it } from 'vitest';
import { toApiError } from '../src/index.js';

describe('toApiError', () => {
  it('does not leak unknown error messages', () => {
    expect(toApiError(new Error('database password=secret'), 'a'.repeat(32))).toEqual({
      code: 'INTERNAL_ERROR',
      message: '系统暂时不可用',
      retryable: true,
      traceId: 'a'.repeat(32),
    });
  });
});
