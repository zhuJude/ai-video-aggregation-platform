import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { CatalogStore } from '../domain/catalog-store.js';

@Controller('v1/models')
export class PublicModelsController {
  constructor(private readonly store: CatalogStore) {}

  @Get()
  listModels() {
    return { items: this.store.listPublicModels() };
  }

  @Get('capabilities/:id')
  getCapability(@Param('id') id: string) {
    const capability = this.store.getPublishedCapability(id);
    if (!capability) throw new NotFoundException('CAPABILITY_NOT_FOUND');
    return {
      id: capability.id,
      modelId: capability.modelId,
      version: capability.version,
      document: capability.document,
      contentSha256: capability.contentSha256,
    };
  }
}
