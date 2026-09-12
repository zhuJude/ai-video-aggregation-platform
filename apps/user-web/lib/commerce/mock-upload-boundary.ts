import 'server-only';

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { PointsStringSchema, UuidSchema } from '@repo/contracts/common';

import { requireMockCommerceSigningKey } from './mock-config';
import type {
  UploadFileDescriptor,
  UploadSessionGrant,
  VerifiedAssetAccess,
  VerifiedUploadGrant,
  VerifiedUploadReceipt,
} from './types';

const TOKEN_TTL_MS = 5 * 60_000;
const UPLOAD_KINDS = [
  { extensions: ['.jpg', '.jpeg'], mimeType: 'image/jpeg', magic: 'JPEG' },
  { extensions: ['.png'], mimeType: 'image/png', magic: 'PNG' },
  { extensions: ['.webp'], mimeType: 'image/webp', magic: 'WEBP' },
  { extensions: ['.mp4'], mimeType: 'video/mp4', magic: 'MP4' },
  { extensions: ['.webm'], mimeType: 'video/webm', magic: 'WEBM' },
  { extensions: ['.mov'], mimeType: 'video/quicktime', magic: 'MOV' },
] as const;
const SHA256 = /^[a-f0-9]{64}$/;

export class UploadBoundaryError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;

  constructor(readonly code: 'EXPIRED' | 'INVALID') {
    super(`UPLOAD_BOUNDARY_${code}`);
  }
}

function storageKey(ownerId: string, assetId: string): string {
  return createHash('sha256').update(`mock-object:v1:${ownerId}:${assetId}`, 'utf8').digest('hex');
}

function exact(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(record).length === keys.length &&
    Object.keys(record).every((key) => keys.includes(key))
  );
}

function encode(payload: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const signature = createHmac('sha256', requireMockCommerceSigningKey())
    .update(encoded, 'ascii')
    .digest('base64url');
  return `${encoded}.${signature}`;
}

function decode(token: string): Record<string, unknown> {
  try {
    if (token.length < 80 || token.length > 4_096) throw new Error('TOKEN_LENGTH');
    const [encoded, signature, extra] = token.split('.');
    if (!encoded || !signature || extra) throw new Error('TOKEN_SHAPE');
    const supplied = Buffer.from(signature, 'base64url');
    const expected = createHmac('sha256', requireMockCommerceSigningKey())
      .update(encoded, 'ascii')
      .digest();
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected))
      throw new Error('TOKEN_SIGNATURE');
    const parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      throw new Error('TOKEN_PAYLOAD');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof UploadBoundaryError) throw error;
    throw new UploadBoundaryError('INVALID');
  }
}

function validateDescriptor(input: UploadFileDescriptor): void {
  if (!input.name.trim() || input.name.length > 120 || !uploadKind(input.name, input.type))
    throw new UploadBoundaryError('INVALID');
  const size = BigInt(input.size);
  const max = input.type.startsWith('image/') ? 20n * 1024n * 1024n : 500n * 1024n * 1024n;
  if (!Number.isSafeInteger(input.size) || size <= 0n || size > max)
    throw new UploadBoundaryError('INVALID');
}

function uploadKind(name: string, mimeType: string) {
  const lowerName = name.toLocaleLowerCase('en-US');
  return UPLOAD_KINDS.find(
    (kind) =>
      kind.mimeType === mimeType &&
      kind.extensions.some((extension) => lowerName.endsWith(extension)),
  );
}

export function isMockUploadDescriptor(name: string, mimeType: string): boolean {
  return uploadKind(name, mimeType) !== undefined;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function ebmlVint(
  bytes: Uint8Array,
  offset: number,
  limit: number,
): { readonly length: number; readonly value: number } | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  let marker = 0x80;
  while (length <= 8 && (first & marker) === 0) {
    length += 1;
    marker >>= 1;
  }
  if (length > 8 || offset + length > limit) return undefined;
  let value = BigInt(first & (marker - 1));
  for (let index = 1; index < length; index += 1) {
    value = (value << 8n) | BigInt(bytes[offset + index] ?? 0);
  }
  const unknownLength = (1n << BigInt(7 * length)) - 1n;
  if (value === unknownLength || value > BigInt(Number.MAX_SAFE_INTEGER)) return undefined;
  return { length, value: Number(value) };
}

function ebmlIdLength(bytes: Uint8Array, offset: number, limit: number): number | undefined {
  const first = bytes[offset];
  if (first === undefined || first === 0) return undefined;
  let length = 1;
  let marker = 0x80;
  while (length <= 4 && (first & marker) === 0) {
    length += 1;
    marker >>= 1;
  }
  return length <= 4 && offset + length <= limit ? length : undefined;
}

function isWebmHeader(bytes: Uint8Array, totalSize: bigint): boolean {
  if (
    bytes.length < 5 ||
    bytes[0] !== 0x1a ||
    bytes[1] !== 0x45 ||
    bytes[2] !== 0xdf ||
    bytes[3] !== 0xa3
  ) {
    return false;
  }
  const headerSize = ebmlVint(bytes, 4, bytes.length);
  if (!headerSize) return false;
  const headerStart = 4 + headerSize.length;
  const headerEnd = headerStart + headerSize.value;
  if (
    !Number.isSafeInteger(headerEnd) ||
    headerEnd > bytes.length ||
    BigInt(headerEnd) > totalSize
  ) {
    return false;
  }
  let cursor = headerStart;
  let foundWebmDocType = false;
  while (cursor < headerEnd) {
    const idLength = ebmlIdLength(bytes, cursor, headerEnd);
    if (!idLength) return false;
    const size = ebmlVint(bytes, cursor + idLength, headerEnd);
    if (!size) return false;
    const valueStart = cursor + idLength + size.length;
    const valueEnd = valueStart + size.value;
    if (!Number.isSafeInteger(valueEnd) || valueEnd > headerEnd) return false;
    if (
      idLength === 2 &&
      bytes[cursor] === 0x42 &&
      bytes[cursor + 1] === 0x82 &&
      size.value === 4
    ) {
      if (ascii(bytes, valueStart, valueEnd) !== 'webm') return false;
      foundWebmDocType = true;
    }
    cursor = valueEnd;
  }
  return cursor === headerEnd && foundWebmDocType;
}

const MP4_BRANDS = new Set([
  'isom',
  'iso2',
  'iso3',
  'iso4',
  'iso5',
  'iso6',
  'mp41',
  'mp42',
  'avc1',
  'dash',
  'msdh',
  'msix',
  'M4V ',
]);
const MOV_BRANDS = new Set(['qt  ']);

function isBmffFileType(
  bytes: Uint8Array,
  totalSize: bigint,
  brands: ReadonlySet<string>,
): boolean {
  if (bytes.length < 16) return false;
  const boxSize =
    (((bytes[0] ?? 0) << 24) |
      ((bytes[1] ?? 0) << 16) |
      ((bytes[2] ?? 0) << 8) |
      (bytes[3] ?? 0)) >>>
    0;
  if (
    boxSize < 16 ||
    boxSize > bytes.length ||
    BigInt(boxSize) > totalSize ||
    (boxSize - 16) % 4 !== 0 ||
    ascii(bytes, 4, 8) !== 'ftyp'
  ) {
    return false;
  }
  return brands.has(ascii(bytes, 8, 12));
}

export function matchesMockUploadSignature(
  name: string,
  mimeType: string,
  bytes: Uint8Array,
  totalSize: bigint = BigInt(bytes.byteLength),
): boolean {
  const kind = uploadKind(name, mimeType);
  if (!kind) return false;
  switch (kind.magic) {
    case 'JPEG':
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'PNG':
      return (
        bytes.length >= 8 &&
        bytes
          .subarray(0, 8)
          .every((byte, index) => byte === [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a][index])
      );
    case 'WEBP':
      return ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP';
    case 'WEBM':
      return isWebmHeader(bytes, totalSize);
    case 'MP4':
      return isBmffFileType(bytes, totalSize, MP4_BRANDS);
    case 'MOV':
      return isBmffFileType(bytes, totalSize, MOV_BRANDS);
  }
}

export function createMockUploadGrant(
  input: UploadFileDescriptor,
  uploadId: string,
  ownerId: string,
  now: number = Date.now(),
): UploadSessionGrant {
  validateDescriptor(input);
  if (!UuidSchema.safeParse(uploadId).success || !UuidSchema.safeParse(ownerId).success)
    throw new UploadBoundaryError('INVALID');
  const expiresAtMs = now + TOKEN_TTL_MS;
  const assetId = uploadId;
  const token = encode({
    version: 1,
    type: 'UPLOAD_GRANT',
    assetId,
    grantId: uploadId,
    idempotencyKey: uploadId,
    storageKey: storageKey(ownerId, assetId),
    ownerId,
    name: input.name,
    mimeType: input.type,
    sizeBytes: String(input.size),
    expiresAtMs,
  });
  return {
    id: assetId,
    url: `/api/commerce/mock-uploads/${token}`,
    headers: {
      'content-type': input.type,
      'x-upload-content-length': String(input.size),
    },
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export function verifyMockUploadGrant(
  token: string,
  now: number = Date.now(),
): VerifiedUploadGrant {
  const payload = decode(token);
  if (
    !exact(payload, [
      'version',
      'type',
      'assetId',
      'grantId',
      'idempotencyKey',
      'storageKey',
      'ownerId',
      'name',
      'mimeType',
      'sizeBytes',
      'expiresAtMs',
    ]) ||
    payload.version !== 1 ||
    payload.type !== 'UPLOAD_GRANT' ||
    !UuidSchema.safeParse(payload.assetId).success ||
    !UuidSchema.safeParse(payload.grantId).success ||
    !UuidSchema.safeParse(payload.idempotencyKey).success ||
    typeof payload.storageKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.storageKey) ||
    !UuidSchema.safeParse(payload.ownerId).success ||
    typeof payload.name !== 'string' ||
    !payload.name.trim() ||
    payload.name.length > 120 ||
    typeof payload.mimeType !== 'string' ||
    !uploadKind(payload.name, payload.mimeType) ||
    !PointsStringSchema.safeParse(payload.sizeBytes).success ||
    !Number.isSafeInteger(payload.expiresAtMs)
  ) {
    throw new UploadBoundaryError('INVALID');
  }
  if ((payload.expiresAtMs as number) <= now) throw new UploadBoundaryError('EXPIRED');
  if (
    payload.assetId !== payload.grantId ||
    payload.assetId !== payload.idempotencyKey ||
    payload.storageKey !== storageKey(payload.ownerId as string, payload.assetId as string)
  ) {
    throw new UploadBoundaryError('INVALID');
  }
  return {
    assetId: payload.assetId as string,
    grantId: payload.grantId as string,
    idempotencyKey: payload.idempotencyKey as string,
    storageKey: payload.storageKey,
    ownerId: payload.ownerId as string,
    name: payload.name,
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes as string,
  };
}

export function createMockUploadReceipt(
  grant: VerifiedUploadGrant,
  sha256: string,
  now: number = Date.now(),
): string {
  if (!SHA256.test(sha256)) throw new UploadBoundaryError('INVALID');
  return encode({
    version: 1,
    type: 'UPLOAD_RECEIPT',
    assetId: grant.assetId,
    grantId: grant.grantId,
    idempotencyKey: grant.idempotencyKey,
    storageKey: grant.storageKey,
    ownerId: grant.ownerId,
    name: grant.name,
    mimeType: grant.mimeType,
    sizeBytes: grant.sizeBytes,
    sha256,
    expiresAtMs: now + TOKEN_TTL_MS,
  });
}

export function verifyMockUploadReceipt(
  token: string,
  now: number = Date.now(),
): VerifiedUploadReceipt {
  const payload = decode(token);
  if (
    !exact(payload, [
      'version',
      'type',
      'assetId',
      'grantId',
      'idempotencyKey',
      'storageKey',
      'ownerId',
      'name',
      'mimeType',
      'sizeBytes',
      'sha256',
      'expiresAtMs',
    ]) ||
    payload.version !== 1 ||
    payload.type !== 'UPLOAD_RECEIPT' ||
    !UuidSchema.safeParse(payload.assetId).success ||
    !UuidSchema.safeParse(payload.grantId).success ||
    !UuidSchema.safeParse(payload.idempotencyKey).success ||
    typeof payload.storageKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.storageKey) ||
    !UuidSchema.safeParse(payload.ownerId).success ||
    typeof payload.name !== 'string' ||
    !payload.name.trim() ||
    payload.name.length > 120 ||
    typeof payload.mimeType !== 'string' ||
    !uploadKind(payload.name, payload.mimeType) ||
    !PointsStringSchema.safeParse(payload.sizeBytes).success ||
    typeof payload.sha256 !== 'string' ||
    !SHA256.test(payload.sha256) ||
    !Number.isSafeInteger(payload.expiresAtMs)
  ) {
    throw new UploadBoundaryError('INVALID');
  }
  if ((payload.expiresAtMs as number) <= now) throw new UploadBoundaryError('EXPIRED');
  if (
    payload.assetId !== payload.grantId ||
    payload.assetId !== payload.idempotencyKey ||
    payload.storageKey !== storageKey(payload.ownerId as string, payload.assetId as string)
  ) {
    throw new UploadBoundaryError('INVALID');
  }
  return {
    assetId: payload.assetId as string,
    grantId: payload.grantId as string,
    idempotencyKey: payload.idempotencyKey as string,
    storageKey: payload.storageKey,
    ownerId: payload.ownerId as string,
    name: payload.name,
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes as string,
    sha256: payload.sha256,
  };
}

export function createMockAssetAccess(
  input: VerifiedAssetAccess,
  now: number = Date.now(),
): { readonly url: string; readonly expiresAt: string } {
  if (
    !UuidSchema.safeParse(input.assetId).success ||
    !UuidSchema.safeParse(input.ownerId).success ||
    !STORAGE_KEY_PATTERN.test(input.storageKey)
  ) {
    throw new UploadBoundaryError('INVALID');
  }
  const expiresAtMs = now + TOKEN_TTL_MS;
  const token = encode({
    version: 1,
    type: 'ASSET_ACCESS',
    assetId: input.assetId,
    ownerId: input.ownerId,
    storageKey: input.storageKey,
    purpose: input.purpose,
    expiresAtMs,
  });
  return {
    url: `/api/commerce/mock-assets/${token}`,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

const STORAGE_KEY_PATTERN = /^[a-f0-9]{64}$/;

export function verifyMockAssetAccess(
  token: string,
  now: number = Date.now(),
): VerifiedAssetAccess {
  const payload = decode(token);
  if (
    !exact(payload, [
      'version',
      'type',
      'assetId',
      'ownerId',
      'storageKey',
      'purpose',
      'expiresAtMs',
    ]) ||
    payload.version !== 1 ||
    payload.type !== 'ASSET_ACCESS' ||
    !UuidSchema.safeParse(payload.assetId).success ||
    !UuidSchema.safeParse(payload.ownerId).success ||
    typeof payload.storageKey !== 'string' ||
    !STORAGE_KEY_PATTERN.test(payload.storageKey) ||
    (payload.purpose !== 'PREVIEW' && payload.purpose !== 'DOWNLOAD') ||
    !Number.isSafeInteger(payload.expiresAtMs)
  ) {
    throw new UploadBoundaryError('INVALID');
  }
  if ((payload.expiresAtMs as number) <= now) throw new UploadBoundaryError('EXPIRED');
  return {
    assetId: payload.assetId as string,
    ownerId: payload.ownerId as string,
    storageKey: payload.storageKey,
    purpose: payload.purpose,
  };
}
