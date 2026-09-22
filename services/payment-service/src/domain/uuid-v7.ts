import { randomBytes } from 'node:crypto';

export function uuidV7(now = Date.now(), random = randomBytes(10)): string {
  if (!Number.isSafeInteger(now) || now < 0 || random.length !== 10) {
    throw new Error('INVALID_UUID_V7_INPUT');
  }
  const bytes = Buffer.allocUnsafe(16);
  bytes.writeUIntBE(now, 0, 6);
  random.copy(bytes, 6);
  bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x70, 6);
  bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
