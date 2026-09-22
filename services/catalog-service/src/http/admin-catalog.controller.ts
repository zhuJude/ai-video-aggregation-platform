import { Body, Controller, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { CapabilityDocumentSchema } from '@repo/capability-schema';
import { CatalogStore } from '../domain/catalog-store.js';

const ProviderInputSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(['ACTIVE', 'MAINTENANCE', 'DISABLED']),
  credentialRefs: z.array(z.string().min(1)),
  maintenanceStartsAt: z.iso.datetime().optional(),
  maintenanceEndsAt: z.iso.datetime().optional(),
});

const ModelInputSchema = z.object({
  id: z.string().min(1),
  providerId: z.string().min(1),
  code: z.string().min(1),
  providerModelId: z.string().min(1),
  displayName: z.string().min(1),
  modes: z
    .array(
      z.enum([
        'TEXT_TO_VIDEO',
        'IMAGE_TO_VIDEO',
        'FIRST_LAST_FRAME',
        'REFERENCE_VIDEO',
        'EXTEND_VIDEO',
      ]),
    )
    .min(1),
  status: z.enum(['DRAFT', 'ACTIVE', 'MAINTENANCE', 'DISABLED']),
  sortOrder: z.int(),
});

const ModelUpdateSchema = z.object({
  displayName: z.string().min(1).optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'MAINTENANCE', 'DISABLED']).optional(),
  sortOrder: z.int().optional(),
  maintenanceStartsAt: z.iso.datetime().optional(),
  maintenanceEndsAt: z.iso.datetime().optional(),
});

const CapabilityInputSchema = z.object({
  id: z.string().min(1),
  version: z.int().positive(),
  document: CapabilityDocumentSchema,
});

@Controller('internal/admin/catalog')
export class AdminCatalogController {
  constructor(private readonly store: CatalogStore) {}

  @Post('providers')
  createProvider(@Body() body: unknown) {
    const input = ProviderInputSchema.parse(body);
    const { maintenanceStartsAt, maintenanceEndsAt, ...required } = input;
    return this.store.createProvider({
      ...required,
      ...(maintenanceStartsAt === undefined ? {} : { maintenanceStartsAt }),
      ...(maintenanceEndsAt === undefined ? {} : { maintenanceEndsAt }),
    });
  }

  @Post('models')
  createModel(@Body() body: unknown) {
    const input = ModelInputSchema.parse(body);
    return this.store.createModel({
      ...input,
      capabilityVersionId: null,
      capabilityStatus: null,
    });
  }

  @Patch('models/:id')
  updateModel(@Param('id') id: string, @Body() body: unknown) {
    const input = ModelUpdateSchema.parse(body);
    const changes: Parameters<CatalogStore['updateModel']>[1] = {};
    if (input.displayName !== undefined) changes.displayName = input.displayName;
    if (input.status !== undefined) changes.status = input.status;
    if (input.sortOrder !== undefined) changes.sortOrder = input.sortOrder;
    if (input.maintenanceStartsAt !== undefined) {
      changes.maintenanceStartsAt = input.maintenanceStartsAt;
    }
    if (input.maintenanceEndsAt !== undefined) {
      changes.maintenanceEndsAt = input.maintenanceEndsAt;
    }
    return this.store.updateModel(id, changes);
  }

  @Post('models/:id/capabilities')
  createCapability(@Param('id') id: string, @Body() body: unknown) {
    return this.store.createCapability(id, CapabilityInputSchema.parse(body));
  }

  @Post('capabilities/:id/publish')
  publishCapability(@Param('id') id: string, @Body() body: unknown) {
    const input = z.object({ publishedBy: z.string().min(1) }).parse(body);
    return this.store.publishCapability(id, input.publishedBy);
  }

  @Post('capabilities/:id/retire')
  retireCapability(@Param('id') id: string, @Body() body: unknown) {
    z.object({ retiredBy: z.string().min(1) }).parse(body);
    return this.store.retireCapability(id);
  }
}
