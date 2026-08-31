import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const AssetKindSchema = z.enum(['UPLOAD', 'RESULT', 'THUMBNAIL']);
export const AssetSchema = z.object({
  id: UuidSchema,
  ownerId: UuidSchema,
  kind: AssetKindSchema,
  objectKey: z.string().min(1),
  mimeType: z.string().min(3),
  sizeBytes: z.string().regex(/^\d+$/),
});
