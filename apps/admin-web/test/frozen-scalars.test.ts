import { describe, expect, it } from 'vitest';

import { isPointsString, isUtcIso8601Z } from '../lib/frozen-scalars';

describe('frozen scalar mirrors', () => {
  it('accepts canonical nonnegative integer point strings without precision loss', () => {
    expect(isPointsString('0')).toBe(true);
    expect(isPointsString('900719925474099312345678901234567890')).toBe(true);
  });

  it.each(['', '-1', '+1', '01', '1.0', '1.25', '1e3', 'NaN', 'Infinity'])(
    'rejects noncanonical points %s',
    (value) => {
      expect(isPointsString(value)).toBe(false);
    },
  );

  it('accepts real UTC ISO-8601 timestamps ending in Z', () => {
    expect(isUtcIso8601Z('2026-08-31T08:00:00Z')).toBe(true);
    expect(isUtcIso8601Z('2026-08-31T08:00:00.000Z')).toBe(true);
  });

  it.each([
    '2026-08-31T16:00:00+08:00',
    '2026-08-31T08:00:00',
    '2026-02-30T08:00:00Z',
    'not-a-date',
  ])('rejects non-UTC or invalid timestamp %s', (value) => {
    expect(isUtcIso8601Z(value)).toBe(false);
  });
});
