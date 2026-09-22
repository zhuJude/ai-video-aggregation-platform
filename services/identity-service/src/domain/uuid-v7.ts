import { randomBytes as nodeRandomBytes } from 'node:crypto';

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_UUID_TIMESTAMP = 0xffff_ffff_ffff;

export interface UuidV7Options {
  readonly now?: () => number;
  readonly randomBytes?: () => Uint8Array;
}

export function generateUuidV7(options: UuidV7Options = {}): string {
  const timestamp = Math.floor((options.now ?? Date.now)());
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > MAX_UUID_TIMESTAMP) {
    throw stableError('INVALID_UUID_V7_TIMESTAMP');
  }
  const entropy = (options.randomBytes ?? (() => nodeRandomBytes(10)))();
  if (entropy.byteLength < 10) throw stableError('INSUFFICIENT_UUID_V7_ENTROPY');

  const bytes = new Uint8Array(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (entropyByte(entropy, 0) & 0x0f);
  bytes[7] = entropyByte(entropy, 1);
  bytes[8] = 0x80 | (entropyByte(entropy, 2) & 0x3f);
  bytes.set(entropy.subarray(3, 10), 9);

  const hex = Buffer.from(bytes).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV7(candidate: string): boolean {
  return UUID_V7_PATTERN.test(candidate);
}

export function assertUuidV7(candidate: string, code = 'INVALID_UUID_V7'): void {
  if (!isUuidV7(candidate)) throw stableError(code);
}

function entropyByte(entropy: Uint8Array, index: number): number {
  const value = entropy[index];
  if (value === undefined) throw stableError('INSUFFICIENT_UUID_V7_ENTROPY');
  return value;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
