import { z } from 'zod';
import { PointsStringSchema, UuidSchema } from '../common/index.js';

export const RechargePackageSchema = z.object({
  id: UuidSchema,
  name: z.string().min(1),
  points: PointsStringSchema,
  bonusPoints: PointsStringSchema,
  active: z.boolean(),
});
export const TicketStatusSchema = z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']);
