export class StrictJsonError extends Error {
  constructor() {
    super('Value is not strict JSON.');
    this.name = 'StrictJsonError';
  }
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, new WeakSet<object>()));
}

function normalize(value: unknown, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new StrictJsonError();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object' || ancestors.has(value)) throw new StrictJsonError();

  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key === 'symbol')) throw new StrictJsonError();
    if (Array.isArray(value)) {
      const normalized: JsonValue[] = [];
      const allowed = new Set<string>(['length']);
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowed.add(key);
        const descriptor = descriptors[key];
        if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
          throw new StrictJsonError();
        }
        normalized.push(normalize(descriptor.value, ancestors));
      }
      if (ownKeys.some((key) => typeof key === 'string' && !allowed.has(key))) {
        throw new StrictJsonError();
      }
      return normalized;
    }

    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) throw new StrictJsonError();
    const normalized = Object.create(null) as Record<string, JsonValue>;
    for (const key of (ownKeys as string[]).sort()) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new StrictJsonError();
      }
      Object.defineProperty(normalized, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: normalize(descriptor.value, ancestors),
      });
    }
    return normalized;
  } finally {
    ancestors.delete(value);
  }
}
