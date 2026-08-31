import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { CatalogStore } from './domain/catalog-store.js';
import { AdminCatalogController } from './http/admin-catalog.controller.js';
import {
  INTERNAL_SERVICE_TOKEN,
  InternalModelsController,
  InternalServiceAuthGuard,
} from './http/internal-models.controller.js';
import { OperationalController } from './http/operational.controller.js';
import { PublicModelsController } from './http/public-models.controller.js';

// Nest uses this metadata-bearing module class as the composition root.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class CatalogModule {}

export async function createCatalogApplication(
  options: { internalServiceToken?: string } = {},
): Promise<{
  app: INestApplication;
  store: CatalogStore;
}> {
  const moduleMetadata = {
    module: CatalogModule,
    controllers: [
      AdminCatalogController,
      PublicModelsController,
      InternalModelsController,
      OperationalController,
    ],
    providers: [
      CatalogStore,
      InternalServiceAuthGuard,
      {
        provide: INTERNAL_SERVICE_TOKEN,
        useValue: options.internalServiceToken ?? process.env.INTERNAL_SERVICE_TOKEN ?? '',
      },
    ],
  };
  const app = await NestFactory.create(moduleMetadata, new FastifyAdapter(), { logger: false });
  return { app, store: app.get(CatalogStore) };
}
