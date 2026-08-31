import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const GenerationModeSchema = z.enum([
  'TEXT_TO_VIDEO',
  'IMAGE_TO_VIDEO',
  'FIRST_LAST_FRAME',
  'REFERENCE_VIDEO',
  'EXTEND_VIDEO',
]);
export const ModelStatusSchema = z.enum(['DRAFT', 'ACTIVE', 'MAINTENANCE', 'DISABLED']);
export const ModelSummarySchema = z.object({
  id: UuidSchema,
  providerId: UuidSchema,
  code: z.string().min(1),
  displayName: z.string().min(1),
  modes: z.array(GenerationModeSchema).min(1),
  status: ModelStatusSchema,
  capabilityVersionId: UuidSchema,
});
