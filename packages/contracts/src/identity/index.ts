import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const UserStatusSchema = z.enum(['ACTIVE', 'SUSPENDED', 'CLOSED']);
export const UserSummarySchema = z.object({
  id: UuidSchema,
  phoneMasked: z.string(),
  nickname: z.string().min(1).max(40),
  status: UserStatusSchema,
});
export const RequestSmsCodeSchema = z.object({
  phone: z.string().regex(/^1\d{10}$/),
});
export const VerifySmsCodeSchema = RequestSmsCodeSchema.extend({
  code: z.string().regex(/^\d{6}$/),
});
