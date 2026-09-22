const POINTS_STRING = /^(?:0|[1-9][0-9]*)$/u;
const UTC_ISO_8601_Z = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,9})?Z$/u;
const MAINLAND_PHONE = /^1[0-9]{10}$/u;
const MASKED_MAINLAND_PHONE = /^1[0-9]{2}\*{4}[0-9]{4}$/u;

export function isPointsString(value: unknown): value is string {
  return typeof value === 'string' && POINTS_STRING.test(value);
}

export function isMainlandPhone(value: unknown): value is string {
  return typeof value === 'string' && MAINLAND_PHONE.test(value);
}

export function isMaskedMainlandPhone(value: unknown): value is string {
  return typeof value === 'string' && MASKED_MAINLAND_PHONE.test(value);
}

export function isUtcIso8601Z(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = UTC_ISO_8601_Z.exec(value);
  if (!match) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 19) === match[1];
}

export function isCoherentPointsAdjustment(
  before: unknown,
  after: unknown,
  points: unknown,
  direction: unknown,
): boolean {
  if (!isPointsString(before) || !isPointsString(after) || !isPointsString(points)) return false;
  const beforePoints = BigInt(before);
  const afterPoints = BigInt(after);
  const adjustmentPoints = BigInt(points);
  if (direction === 'CREDIT') return afterPoints === beforePoints + adjustmentPoints;
  if (direction === 'DEBIT')
    return beforePoints >= adjustmentPoints && afterPoints === beforePoints - adjustmentPoints;
  return false;
}
