import { z } from 'zod';

export const ApiErrorSchema = z.object({
  code: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
  message: z.string().min(1),
  traceId: z.string().regex(/^[a-f0-9]{32}$/),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional(),
});

export type ApiError = z.infer<typeof ApiErrorSchema>;
