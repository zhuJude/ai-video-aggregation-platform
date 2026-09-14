import { randomBytes } from 'node:crypto';

export function createUuidV7Generator(now: () => number = Date.now): () => string {
  let sequence = 0;
  let last = -1;
  return () => {
    const timestamp = Math.max(Math.trunc(now()), last);
    sequence =
      timestamp === last ? (sequence + 1) & 0x0fff : randomBytes(2).readUInt16BE() & 0x0fff;
    last = timestamp;
    const tail = randomBytes(8).toString('hex');
    const time = timestamp.toString(16).padStart(12, '0').slice(-12);
    const variant = ((Number.parseInt(tail.slice(0, 2), 16) & 0x3f) | 0x80)
      .toString(16)
      .padStart(2, '0');
    return `${time.slice(0, 8)}-${time.slice(8)}-7${sequence.toString(16).padStart(3, '0')}-${variant}${tail.slice(2, 4)}-${tail.slice(4)}`;
  };
}

export const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
