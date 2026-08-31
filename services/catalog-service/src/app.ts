import 'reflect-metadata';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import { CatalogStore } from './domain/catalog-store.js';
import { AdminCatalogController } from './http/admin-catalog.controller.js';
import { PublicModelsController } from './http/public-models.controller.js';

@Module({
  controllers: [AdminCatalogController, PublicModelsController],
  providers: [CatalogStore],
})
// Nest uses this metadata-bearing module class as the composition root.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class CatalogModule {}

export async function createCatalogApplication(): Promise<{
  app: INestApplication;
  store: CatalogStore;
}> {
  const app = await NestFactory.create(CatalogModule, new FastifyAdapter(), { logger: false });
  return { app, store: app.get(CatalogStore) };
}
