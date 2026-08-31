import { z } from 'zod';
import { UuidSchema } from '../common/index.js';

export const PermissionKeySchema = z.string().regex(/^[a-z]+:[a-z-]+$/);
export const RoleSchema = z.object({
  id: UuidSchema,
  name: z.string().min(2).max(40),
  permissions: z.array(PermissionKeySchema),
  dataScope: z.enum(['ALL', 'OWN', 'ASSIGNED']),
});
