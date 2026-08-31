import { z } from 'zod';
import { PointsStringSchema } from '../common/index.js';

export const DailyBusinessMetricSchema = z.object({
  date: z.iso.date(),
  rechargePoints: PointsStringSchema,
  consumedPoints: PointsStringSchema,
  providerCostMinor: z.string().regex(/^\d+$/),
  successfulTasks: z.int().nonnegative(),
  failedTasks: z.int().nonnegative(),
});
