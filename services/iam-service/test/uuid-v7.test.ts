import { describe, expect, it } from 'vitest';

import { generateUuidV7, isUuidV7 } from '../src/domain/uuid-v7.js';

describe('IAM UUIDv7', () => {
  it('creates RFC 9562 version-7 identifiers for new records', () => {
    const id = generateUuidV7({
      now: () => Date.UTC(2026, 8, 1),
      randomBytes: () => Uint8Array.from({ length: 10 }, (_, index) => index + 1),
    });
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(isUuidV7(id)).toBe(true);
  });
});
