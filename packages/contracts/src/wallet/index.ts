import { z } from 'zod';
import { PointsStringSchema, UuidSchema } from '../common/index.js';

export const LedgerKindSchema = z.enum(['CREDIT', 'RESERVE', 'SETTLE', 'RELEASE', 'ADJUST']);
export const LedgerCommandSchema = z.object({
  businessKey: z.string().min(8).max(120),
  userId: UuidSchema,
  kind: LedgerKindSchema,
  points: PointsStringSchema,
  reason: z.string().max(240).optional(),
});
export const WalletBalanceSchema = z.object({
  userId: UuidSchema,
  available: PointsStringSchema,
  frozen: PointsStringSchema,
});
