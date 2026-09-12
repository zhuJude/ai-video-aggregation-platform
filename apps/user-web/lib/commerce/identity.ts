import 'server-only';

import { createHmac } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';

import { requireMockCommerceIdentityKey } from './mock-config';

const VERIFIED_PHONE = /^\+861[3-9]\d{9}$/;

export function commerceOwnerIdFromPhone(phone: string): string {
  if (!VERIFIED_PHONE.test(phone)) throw new Error('INVALID_VERIFIED_COMMERCE_OWNER');
  // This stable, independently rotated key prevents upload-token key rotation from changing owners.
  const bytes = createHmac('sha256', requireMockCommerceIdentityKey())
    .update(`commerce-owner:v1:${phone}`, 'utf8')
    .digest()
    .subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  const ownerId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  const parsed = UuidSchema.safeParse(ownerId);
  if (!parsed.success) throw new Error('INVALID_DERIVED_COMMERCE_OWNER');
  return parsed.data;
}
