import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import { Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import {
  InMemoryQuoteRepository,
  QuoteService,
} from './application/quote.service.js';
import { RuleVersionStore } from './application/rule-version.store.js';
import { AdminRoutingController } from './http/admin-routing.controller.js';
import { OperationalController } from './http/operational.controller.js';
import { QuotesController } from './http/quotes.controller.js';

function createUuidV7(): string {
  const bytes = randomBytes(16);
  let timestamp = BigInt(Date.now());
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  const versionByte = bytes[6] ?? 0;
  const variantByte = bytes[8] ?? 0;
  bytes[6] = (versionByte & 0x0f) | 0x70;
  bytes[8] = (variantByte & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

@Module({
  controllers: [QuotesController, AdminRoutingController, OperationalController],
  providers: [
    InMemoryQuoteRepository,
    RuleVersionStore,
    {
      provide: QuoteService,
      inject: [InMemoryQuoteRepository],
      useFactory: (repository: InMemoryQuoteRepository) =>
        new QuoteService(repository, createUuidV7),
    },
  ],
})
// Nest uses this metadata-bearing module class as the composition root.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class QuoteRoutingModule {}

export async function createQuoteRoutingApplication(): Promise<{
  app: INestApplication;
  repository: InMemoryQuoteRepository;
}> {
  const app = await NestFactory.create(QuoteRoutingModule, new FastifyAdapter(), {
    logger: false,
  });
  return { app, repository: app.get(InMemoryQuoteRepository) };
}
