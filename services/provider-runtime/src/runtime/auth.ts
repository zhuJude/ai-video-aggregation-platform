import { timingSafeEqual } from 'node:crypto';

export function validBearerAuthorization(
  value: string | string[] | undefined,
  tokens: readonly string[],
): boolean {
  if (typeof value !== 'string') return false;
  const received = Buffer.from(value);
  const matches = tokens.map((token) => {
    const expected = Buffer.from(`Bearer ${token}`);
    return received.length === expected.length && timingSafeEqual(received, expected);
  });
  return matches.some(Boolean);
}

export function requiredSecretList(
  environment: Readonly<Record<string, string | undefined>>,
  listName: string,
  legacyName: string,
): readonly string[] {
  const list = environment[listName];
  const legacy = environment[legacyName];
  if (list !== undefined && legacy !== undefined) throw new Error(`${listName}_CONFLICT`);
  const source = list ?? legacy;
  const values = source?.split(',').map((value) => value.trim()) ?? [];
  if (
    values.length < 1 ||
    values.length > 2 ||
    values.some((value) => value.length < 32) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${listName}_REQUIRED`);
  }
  return values;
}
