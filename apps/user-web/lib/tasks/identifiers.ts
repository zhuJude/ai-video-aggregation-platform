import { UuidSchema } from '@repo/contracts/common';

const TASK_EVENT_CURSOR_PATTERN = /^(0|[1-9]\d*):(.+)$/;

export function isUuidV7(value: unknown): value is string {
  return UuidSchema.safeParse(value).success;
}

export function isTaskEventCursor(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = TASK_EVENT_CURSOR_PATTERN.exec(value);
  return match !== null && isUuidV7(match[2]);
}

export function createUuidV7(now = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > 0xffffffffffff) {
    throw new Error('INVALID_UUID_V7_TIMESTAMP');
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = now;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = timestamp % 256;
    timestamp = Math.floor(timestamp / 256);
  }
  const versionByte = bytes[6];
  const variantByte = bytes[8];
  if (versionByte === undefined || variantByte === undefined) {
    throw new Error('UUID_V7_RANDOMNESS_UNAVAILABLE');
  }
  bytes[6] = (versionByte & 0x0f) | 0x70;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
