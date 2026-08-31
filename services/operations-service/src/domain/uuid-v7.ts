import { randomBytes } from 'node:crypto';

export type UuidV7Factory = () => string;

/** RFC 9562 UUIDv7 with a monotonic 12-bit counter inside one millisecond. */
export function createUuidV7Generator(
  now: () => number = Date.now,
  entropy: () => Uint8Array = () => randomBytes(10),
): UuidV7Factory {
  let lastTimestamp = -1;
  let sequence = 0;
  return () => {
    let timestamp = Math.max(Math.trunc(now()), lastTimestamp);
    if (timestamp === lastTimestamp) {
      if (sequence === 0x0fff) { timestamp = lastTimestamp + 1; sequence = 0; }
      else sequence += 1;
    } else {
      const seed = entropy();
      sequence = (((seed[0] ?? 0) << 4) | ((seed[1] ?? 0) >>> 4)) & 0x0fff;
    }
    lastTimestamp = timestamp;
    const bytes = entropy();
    const timeHex = timestamp.toString(16).padStart(12, '0').slice(-12);
    const seqHex = sequence.toString(16).padStart(3, '0');
    const tail = Array.from(bytes.slice(2, 10), (byte) => byte.toString(16).padStart(2, '0')).join('').padEnd(16, '0');
    const variant = ((Number.parseInt(tail.slice(0, 2), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
    return `${timeHex.slice(0, 8)}-${timeHex.slice(8)}-7${seqHex}-${variant}${tail.slice(2, 4)}-${tail.slice(4, 16)}`;
  };
}

export function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
