import { describe, expect, it } from 'vitest';
import { canonicalJson, StrictJsonError } from '../src/domain/canonical-json.js';

describe('canonicalJson', () => {
  it('sorts object keys recursively and normalizes negative zero', () => {
    expect(canonicalJson({ z: -0, a: { y: 2, x: 1 } })).toBe('{"a":{"x":1,"y":2},"z":0}');
  });

  it('preserves an enumerable __proto__ data property as data', () => {
    const value = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(value, '__proto__', { enumerable: true, value: 'safe' });
    expect(canonicalJson(value)).toBe('{"__proto__":"safe"}');
  });

  it.each([
    undefined,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date('2026-08-31T00:00:00.000Z'),
    Object.assign([1], { extra: true }),
  ])('rejects non-strict JSON value %#', (value) => {
    expect(() => canonicalJson(value)).toThrow(StrictJsonError);
  });

  it('rejects sparse arrays, accessors, symbols and cycles', () => {
    const sparse = new Array(1);
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'value', { enumerable: true, get: () => 1 });
    const symbolic = { value: 1, [Symbol('secret')]: 2 };
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const value of [sparse, accessor, symbolic, cyclic]) {
      expect(() => canonicalJson(value)).toThrow(StrictJsonError);
    }
  });
});
