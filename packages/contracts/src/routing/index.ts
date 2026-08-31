import { z } from 'zod';
import { PointsStringSchema, UtcDateTimeSchema, UuidSchema } from '../common/index.js';

export const QuoteSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  modelId: UuidSchema.optional(),
  candidateModelIds: z.array(UuidSchema).default([]),
  capabilityVersionId: UuidSchema,
  quotedPoints: PointsStringSchema,
  pricingRuleVersion: z.int().positive(),
  expiresAt: UtcDateTimeSchema,
  parametersHash: z.string().regex(/^[a-f0-9]{64}$/),
});
