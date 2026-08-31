import { z } from 'zod';
import { UtcDateTimeSchema, UuidSchema } from './scalars.js';

export const EventEnvelopeSchema = z.object({
  id: UuidSchema,
  type: z.string().regex(/^[a-z][a-z0-9.-]+\.v\d+$/),
  version: z.int().positive(),
  occurredAt: UtcDateTimeSchema,
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  correlationId: UuidSchema,
  causationId: UuidSchema.optional(),
  producer: z.string().min(1),
  data: z.unknown(),
});

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
