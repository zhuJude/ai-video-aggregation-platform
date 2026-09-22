export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export class StrictJsonError extends Error {
  constructor() {
    super('Value is not strict JSON.');
    this.name = 'StrictJsonError';
  }
}

function reject(): never {
  throw new StrictJsonError();
}

function normalize(value: unknown, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return reject();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') return reject();
  if (ancestors.has(value)) return reject();

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) return reject();

    if (Array.isArray(value)) {
      const allowedKeys = new Set<string>(['length']);
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = descriptors[key];
        if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
          return reject();
        }
        result.push(normalize(descriptor.value, ancestors));
      }
      if (ownKeys.some((key) => typeof key === 'string' && !allowedKeys.has(key))) return reject();
      return result;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return reject();
    const result = Object.create(null) as Record<string, JsonValue>;
    const keys = ownKeys as string[];
    for (const key of keys.sort()) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
        return reject();
      }
      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: normalize(descriptor.value, ancestors),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function normalizeJson(value: unknown): JsonValue {
  return normalize(value, new WeakSet<object>());
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}
