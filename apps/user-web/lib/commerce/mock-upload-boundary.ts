import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { PointsStringSchema, UuidSchema } from '@repo/contracts/common';

import { requireMockCommerceSigningKey } from './mock-config';
import type {
  UploadFileDescriptor,
  UploadSessionGrant,
  VerifiedUploadGrant,
  VerifiedUploadReceipt,
} from './types';

const TOKEN_TTL_MS = 5 * 60_000;
const ALLOWED_UPLOADS = /^(?:image\/(?:jpeg|png|webp)|video\/mp4)$/;
const SHA256 = /^[a-f0-9]{64}$/;

export class UploadBoundaryError extends Error {
  constructor(readonly code: 'EXPIRED' | 'INVALID') {
    super(`UPLOAD_BOUNDARY_${code}`);
  }
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
  if (!input.name.trim() || input.name.length > 120 || !ALLOWED_UPLOADS.test(input.type))
    throw new UploadBoundaryError('INVALID');
  const size = BigInt(input.size);
  const max = input.type.startsWith('image/') ? 20n * 1024n * 1024n : 500n * 1024n * 1024n;
  if (!Number.isSafeInteger(input.size) || size <= 0n || size > max)
    throw new UploadBoundaryError('INVALID');
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
  const token = encode({
    version: 1,
    type: 'UPLOAD_GRANT',
    uploadId,
    ownerId,
    name: input.name,
    mimeType: input.type,
    sizeBytes: String(input.size),
    expiresAtMs,
  });
  return {
    id: uploadId,
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
      'uploadId',
      'ownerId',
      'name',
      'mimeType',
      'sizeBytes',
      'expiresAtMs',
    ]) ||
    payload.version !== 1 ||
    payload.type !== 'UPLOAD_GRANT' ||
    !UuidSchema.safeParse(payload.uploadId).success ||
    !UuidSchema.safeParse(payload.ownerId).success ||
    typeof payload.name !== 'string' ||
    !payload.name.trim() ||
    payload.name.length > 120 ||
    typeof payload.mimeType !== 'string' ||
    !ALLOWED_UPLOADS.test(payload.mimeType) ||
    !PointsStringSchema.safeParse(payload.sizeBytes).success ||
    !Number.isSafeInteger(payload.expiresAtMs)
  ) {
    throw new UploadBoundaryError('INVALID');
  }
  if ((payload.expiresAtMs as number) <= now) throw new UploadBoundaryError('EXPIRED');
  return {
    uploadId: payload.uploadId as string,
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
    uploadId: grant.uploadId,
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
      'uploadId',
      'ownerId',
      'name',
      'mimeType',
      'sizeBytes',
      'sha256',
      'expiresAtMs',
    ]) ||
    payload.version !== 1 ||
    payload.type !== 'UPLOAD_RECEIPT' ||
    !UuidSchema.safeParse(payload.uploadId).success ||
    !UuidSchema.safeParse(payload.ownerId).success ||
    typeof payload.name !== 'string' ||
    !payload.name.trim() ||
    payload.name.length > 120 ||
    typeof payload.mimeType !== 'string' ||
    !ALLOWED_UPLOADS.test(payload.mimeType) ||
    !PointsStringSchema.safeParse(payload.sizeBytes).success ||
    typeof payload.sha256 !== 'string' ||
    !SHA256.test(payload.sha256) ||
    !Number.isSafeInteger(payload.expiresAtMs)
  ) {
    throw new UploadBoundaryError('INVALID');
  }
  if ((payload.expiresAtMs as number) <= now) throw new UploadBoundaryError('EXPIRED');
  return {
    uploadId: payload.uploadId as string,
    ownerId: payload.ownerId as string,
    name: payload.name,
    mimeType: payload.mimeType,
    sizeBytes: payload.sizeBytes as string,
    sha256: payload.sha256,
  };
}
