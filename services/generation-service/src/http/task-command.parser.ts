import { CreateTaskCommandSchema } from '@repo/contracts/generation';
import type { CreateTaskCommand } from '../application/create-task.service.js';
import { normalizeJson, type JsonObject } from '../domain/canonical-json.js';

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses an HTTP command without letting the contract parser reconstruct and
 * silently discard JSON keys such as an own `__proto__` property.
 */
export function parseTransportTaskCommand(
  body: unknown,
  principalUserId: string,
): CreateTaskCommand | null {
  try {
    const normalizedBody = normalizeJson(body);
    if (!isJsonObject(normalizedBody)) return null;

    const normalizedParameters = normalizedBody.parameters;
    if (!isJsonObject(normalizedParameters)) return null;

    const candidate = Object.create(null) as Record<string, unknown>;
    for (const [key, value] of Object.entries(normalizedBody)) {
      Object.defineProperty(candidate, key, {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    }
    Object.defineProperty(candidate, 'userId', {
      configurable: true,
      enumerable: true,
      value: principalUserId,
      writable: true,
    });

    const parsed = CreateTaskCommandSchema.safeParse(candidate);
    if (!parsed.success) return null;
    return { ...parsed.data, parameters: normalizedParameters };
  } catch {
    return null;
  }
}
