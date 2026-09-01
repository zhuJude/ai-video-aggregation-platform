import { describe, expect, it } from 'vitest';

import { generateUuidV7, isUuidV7 } from '../src/domain/uuid-v7.js';

describe('UUIDv7', () => {
  it('uses CSPRNG entropy by default', () => {
    expect(generateUuidV7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('encodes the millisecond timestamp with v7 and RFC variant bits', () => {
    const uuid = generateUuidV7({
      now: () => 1_777_777_777_777,
      randomBytes: () => Uint8Array.from({ length: 10 }, (_, index) => index + 1),
    });

    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Number.parseInt(uuid.replaceAll('-', '').slice(0, 12), 16)).toBe(1_777_777_777_777);
    expect(isUuidV7(uuid)).toBe(true);
  });

  it.each([
    '11111111-1111-4111-8111-111111111111',
    'not-a-uuid',
    '0198fabc-1234-7abc-4abc-111111111111',
  ])('rejects a non-v7 identifier: %s', (candidate) => {
    expect(isUuidV7(candidate)).toBe(false);
  });
});
