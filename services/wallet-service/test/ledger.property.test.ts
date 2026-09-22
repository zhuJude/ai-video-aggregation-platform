import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  adjustmentEntries,
  assertBalanced,
  creditEntries,
  refundEntries,
  releaseEntries,
  reserveEntries,
  settleEntries,
} from '../src/domain/ledger.js';

describe('balanced ledger entry drafts', () => {
  it.each([
    ['reserve', reserveEntries],
    ['credit', creditEntries],
    ['refund', refundEntries],
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

  it('rejects unbalanced or single-entry postings and zero adjustments', () => {
    expect(() => {
      assertBalanced([
        { account: 'USER_AVAILABLE', ownerId: 'user-1', delta: 2n },
        { account: 'PLATFORM_LIABILITY', ownerId: 'platform', delta: -1n },
      ]);
    }).toThrow(expect.objectContaining({ code: 'UNBALANCED_LEDGER_TRANSACTION' }));
    expect(() => {
      assertBalanced([{ account: 'USER_AVAILABLE', ownerId: 'user-1', delta: 0n }]);
    }).toThrow(expect.objectContaining({ code: 'UNBALANCED_LEDGER_TRANSACTION' }));
    expect(() => adjustmentEntries('user-1', 0n)).toThrow(
      expect.objectContaining({ code: 'INVALID_POINTS' }),
    );
  });
});
