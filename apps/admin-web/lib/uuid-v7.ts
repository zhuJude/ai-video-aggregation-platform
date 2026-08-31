const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

let lastTimestamp = -1;
let lastSequence = 0;

function hex(value: number): string {
  return value.toString(16).padStart(2, '0');
}

export function isUuidV7(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7.test(value);
}

export function isSameUuidV7(left: unknown, right: unknown): boolean {
  return isUuidV7(left) && isUuidV7(right) && left.toLowerCase() === right.toLowerCase();
}

export function createUuidV7(now = Date.now()): string {
  let timestamp = Math.max(0, Math.floor(now));
  if (timestamp < lastTimestamp) timestamp = lastTimestamp;
  const random = crypto.getRandomValues(new Uint8Array(10));
  if (timestamp === lastTimestamp) {
    lastSequence = (lastSequence + 1) & 0x0fff;
    if (lastSequence === 0) timestamp += 1;
  } else {
    lastSequence = ((random[0] ?? 0) << 4 | (random[1] ?? 0) >>> 4) & 0x0fff;
  }
  lastTimestamp = timestamp;
  const bytes = new Uint8Array(16);
  let remaining = timestamp;
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  bytes[6] = 0x70 | (lastSequence >>> 8);
  bytes[7] = lastSequence & 0xff;
  bytes[8] = 0x80 | ((random[2] ?? 0) & 0x3f);
  bytes.set(random.slice(3), 9);
  const encoded = Array.from(bytes, hex).join('');
  return `${encoded.slice(0, 8)}-${encoded.slice(8, 12)}-${encoded.slice(12, 16)}-${encoded.slice(16, 20)}-${encoded.slice(20)}`;
}
