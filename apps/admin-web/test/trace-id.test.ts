import { describe, expect, it } from 'vitest';

import { createTraceId, isTraceId } from '../lib/trace-id';

describe('frozen trace identifier contract', () => {
  it('accepts only 16-byte lowercase hexadecimal trace values', () => {
    expect(isTraceId('00112233445566778899aabbccddeeff')).toBe(true);
    expect(isTraceId('00112233445566778899AABBCCDDEEFF')).toBe(false);
    expect(isTraceId('0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f')).toBe(false);
    expect(isTraceId('00112233445566778899aabbccddee')).toBe(false);
  });

  it('creates unique secure 16-byte lowercase hexadecimal values', () => {
    const values = Array.from({ length: 32 }, () => createTraceId());
    expect(values.every(isTraceId)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
  });
});
