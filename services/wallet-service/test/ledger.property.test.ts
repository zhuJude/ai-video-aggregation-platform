import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { releaseEntries, reserveEntries, settleEntries } from '../src/domain/ledger.js';

describe('balanced ledger entry drafts', () => {
  it.each([
    ['reserve', reserveEntries],
    ['settle', settleEntries],
    ['release', releaseEntries],
  ] as const)('balances every positive %s transaction', (_name, createEntries) => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000n }), (points) => {
        const entries = createEntries('user-1', points);

        expect(entries.reduce((sum, entry) => sum + entry.delta, 0n)).toBe(0n);
      }),
    );
  });

  it.each([0n, -1n])('rejects invalid point command %s', (points) => {
    expect(() => reserveEntries('user-1', points)).toThrow(
      expect.objectContaining({ code: 'INVALID_POINTS' }),
    );
  });
});
