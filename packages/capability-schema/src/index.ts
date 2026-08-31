import { GenerationModeSchema } from '@repo/contracts/catalog';
import { z } from 'zod';

const JsonSchemaSchema = z
  .record(z.string(), z.unknown())
  .refine((value) => value.type === 'object', 'root JSON Schema type must be object');

const UiGroupSchema = z.object({
  key: z.string().min(1),
  title: z.string().min(1),
  fields: z.array(z.string()).min(1),
});

export const CapabilityDocumentSchema = z.object({
  schemaVersion: z.int().positive(),
  mode: GenerationModeSchema,
  jsonSchema: JsonSchemaSchema,
  uiSchema: z.object({
    order: z.array(z.string()),
    groups: z.array(UiGroupSchema),
  }),
  costDimensions: z.array(z.string()),
});

export type CapabilityDocument = z.infer<typeof CapabilityDocumentSchema>;
