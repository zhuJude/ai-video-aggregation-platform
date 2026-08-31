import { describe, expect, it } from 'vitest';

import { createUuidV7, isSameUuidV7, isUuidV7 } from '../lib/uuid-v7';

describe('frozen UUIDv7 contract', () => {
  it('accepts canonical UUIDv7 values and rejects UUIDv4 or arbitrary identifiers', () => {
    expect(isUuidV7('0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f')).toBe(true);
    expect(isUuidV7('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
    expect(isUuidV7('not-an-identifier')).toBe(false);
    expect(isUuidV7('0198F7A4-C6D2-7B39-8A4E-73AF0C1D2E3F')).toBe(true);
  });

  it('binds valid UUIDv7 identifiers case-insensitively without accepting other values', () => {
    const lower = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
    expect(isSameUuidV7(lower, lower.toUpperCase())).toBe(true);
    expect(isSameUuidV7(lower, '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f')).toBe(false);
    expect(isSameUuidV7(lower, 'not-an-identifier')).toBe(false);
  });

  it('creates canonical, cryptographically-random UUIDv7 values that do not regress in generation order', () => {
    const ids = Array.from({ length: 32 }, () => createUuidV7());
    expect(ids.every(isUuidV7)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(ids.every((id) => id === id.toLowerCase())).toBe(true);
  });
});
