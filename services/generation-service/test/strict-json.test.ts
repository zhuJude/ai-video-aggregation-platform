import { describe, expect, it, vi } from 'vitest';
import { canonicalJson, normalizeJson, StrictJsonError } from '../src/domain/canonical-json.js';

describe('strict JSON normalization', () => {
  it('clones dense JSON without prototypes and encodes sorted keys deterministically', () => {
    const input = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(input, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { polluted: true },
      writable: true,
    });
    input['é'] = -0;
    input['e\u0301'] = [null, true, 3.5];

    const normalized = normalizeJson(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(normalized)).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(normalized, '__proto__')).toBe(true);
    expect(normalized['__proto__']).toEqual({ polluted: true });
    expect(canonicalJson(input)).toBe('{"__proto__":{"polluted":true},"é":[null,true,3.5],"é":0}');
    expect(canonicalJson(input)).not.toBe(canonicalJson({}));
  });

  it.each([
    ['undefined', undefined],
    ['bigint', 1n],
    ['symbol', Symbol('nope')],
    ['function', () => undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['Date', new Date('2026-08-31T08:00:00.000Z')],
    [
      'custom prototype',
      new (class Example {
        readonly marker = true;
      })(),
    ],
    ['toJSON', { toJSON: () => ({ disguised: true }) }],
    ['sparse array', Array(2)],
  ])('rejects %s values', (_label, value) => {
    expect(() => normalizeJson(value)).toThrow(StrictJsonError);
  });

  it('rejects accessors without invoking them', () => {
    const getter = vi.fn(() => 'secret');
    const input = Object.defineProperty({}, 'value', { enumerable: true, get: getter });

    expect(() => normalizeJson(input)).toThrow(StrictJsonError);
    expect(getter).not.toHaveBeenCalled();
  });

  it('rejects cyclic graphs', () => {
    const input: Record<string, unknown> = {};
    input.self = input;

    expect(() => normalizeJson(input)).toThrow(StrictJsonError);
  });

  it('rejects symbol keys and non-index array properties', () => {
    const symbolKey = { ordinary: true, [Symbol('hidden')]: 'not-json' };
    const decorated = [1, 2] as unknown[] & { metadata?: string };
    decorated.metadata = 'not-json';

    expect(() => normalizeJson(symbolKey)).toThrow(StrictJsonError);
    expect(() => normalizeJson(decorated)).toThrow(StrictJsonError);
  });
});
