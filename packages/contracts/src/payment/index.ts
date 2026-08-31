import { z } from 'zod';
import {
  CurrencySchema,
  MinorAmountSchema,
  PointsStringSchema,
  UuidSchema,
} from '../common/index.js';

export const PaymentStatusSchema = z.enum(['PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'FAILED']);
export const RechargeOrderSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  amountMinor: MinorAmountSchema,
  currency: CurrencySchema,
  points: PointsStringSchema,
  status: PaymentStatusSchema,
});
