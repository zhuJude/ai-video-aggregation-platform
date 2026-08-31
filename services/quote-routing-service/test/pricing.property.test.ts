import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  calculateCost,
  priceWithMargin,
  priceWithTiers,
  selectEffectiveVersion,
} from '../src/domain/pricing.js';

describe('integer pricing', () => {
  it('never produces a negative or floating point price', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000n }),
        fc.integer({ min: 0, max: 5000 }),
        (base, marginBps) => {
          const price = priceWithMargin(base, marginBps);
          expect(price >= 0n).toBe(true);
          expect(typeof price).toBe('bigint');
        },
      ),
    );
  });

  it('rounds fractional points upward without floating point arithmetic', () => {
    expect(priceWithMargin(1n, 1)).toBe(2n);
    expect(priceWithMargin(100n, 2500)).toBe(125n);
  });

  it.each([
    [-1n, 0],
    [1n, -1],
    [1n, 0.5],
  ])('rejects invalid pricing input %s/%s', (cost, marginBps) => {
    expect(() => priceWithMargin(cost, marginBps)).toThrow('INVALID_PRICING_INPUT');
  });

  it('calculates base and dimensional cost entirely as bigint', () => {
    expect(calculateCost({ basePoints: 5n, unitPoints: 3n, units: 4n })).toBe(17n);
  });

  it('calculates tiered prices using integer units and an open final tier', () => {
    expect(
      priceWithTiers(12n, [
        { upToUnits: 10n, unitPricePoints: 2n },
        { upToUnits: null, unitPricePoints: 1n },
      ]),
    ).toBe(22n);
  });

  it('selects the latest immutable rule effective at the quote time', () => {
    const selected = selectEffectiveVersion(
      [
        { version: 1, effectiveAt: new Date('2026-08-31T00:00:00.000Z') },
        { version: 2, effectiveAt: new Date('2026-09-01T00:00:00.000Z') },
      ],
      new Date('2026-08-31T12:00:00.000Z'),
    );

    expect(selected.version).toBe(1);
  });
});
