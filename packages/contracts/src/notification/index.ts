import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const NotificationChannelSchema = z.enum(['IN_APP', 'SMS']);
export const NotificationCommandSchema = z.object({
  id: UuidSchema,
  userId: UuidSchema,
  templateKey: z.string().min(1),
  channel: NotificationChannelSchema,
  variables: z.record(z.string(), z.string()),
});
