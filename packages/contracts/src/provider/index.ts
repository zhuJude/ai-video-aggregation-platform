import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const ProviderTaskStateSchema = z.enum([
  'ACCEPTED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELED',
]);
export const ProviderExecutionSchema = z.object({
  taskId: UuidSchema,
  providerId: UuidSchema,
  providerTaskId: z.string().min(1),
  state: ProviderTaskStateSchema,
  rawCode: z.string().optional(),
});
