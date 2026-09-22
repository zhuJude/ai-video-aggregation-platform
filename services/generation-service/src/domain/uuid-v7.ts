import { randomBytes } from 'node:crypto';

export interface UuidV7Source {
  next(): string;
}

export class UuidV7Generator implements UuidV7Source {
  next(): string {
    const bytes = randomBytes(16);
    let timestamp = BigInt(Date.now());

    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Number(timestamp & 0xffn);
      timestamp >>= 8n;
    }

    bytes.writeUInt8(0x70 | (bytes.readUInt8(6) & 0x0f), 6);
    bytes.writeUInt8(0x80 | (bytes.readUInt8(8) & 0x3f), 8);
    const hex = bytes.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
