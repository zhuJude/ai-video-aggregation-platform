import { z } from 'zod';
import { PointsStringSchema, UuidSchema } from '../common/index.js';

export const TaskStatusSchema = z.enum([
  'QUOTED',
  'RESERVED',
  'QUEUED',
  'SUBMITTING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
  'EXPIRED',
  'SETTLED',
  'REFUNDED',
]);
export const CreateTaskCommandSchema = z.object({
  userId: UuidSchema,
  quoteId: UuidSchema,
  capabilityVersionId: UuidSchema,
  parameters: z.record(z.string(), z.unknown()),
  quotedPoints: PointsStringSchema,
});
