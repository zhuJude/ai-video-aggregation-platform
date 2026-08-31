import 'reflect-metadata';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { traceMiddleware } from '@repo/service-kit';
import type { FastifyInstance } from 'fastify';
import { GatewayErrorFilter } from './http/error-handler.js';

export interface GatewayAppOptions {
  readonly allowedOrigins?: readonly string[];
  readonly exposeTestRoutes?: boolean;
  readonly trustProxy?: boolean | string | string[];
}

@Controller('test')
class TestErrorController {
  @Get('error')
  error(): never {
    throw new Error('secret-upstream-url');
  }
}

export async function createGatewayApp(
  options: GatewayAppOptions = {},
): Promise<FastifyInstance> {
  // Nest uses the decorated class itself as the runtime module token.
  // eslint-disable-next-line @typescript-eslint/no-extraneous-class
  class RuntimeGatewayModule {}
  Module({ controllers: options.exposeTestRoutes === true ? [TestErrorController] : [] })(
    RuntimeGatewayModule,
  );
  const adapter = new FastifyAdapter({
    bodyLimit: 1024 * 1024,
    trustProxy: options.trustProxy ?? false,
  });
  const nestApp = await NestFactory.create<NestFastifyApplication>(RuntimeGatewayModule, adapter, {
    logger: false,
  });
  const app = adapter.getInstance();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);

  await app.register(cors, {
    credentials: true,
    origin(origin, callback) {
      callback(null, origin === undefined || allowedOrigins.has(origin));
    },
  });
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: { includeSubDomains: true, maxAge: 31_536_000, preload: true },
  });
  app.addHook('onRequest', traceMiddleware);
  nestApp.useGlobalFilters(new GatewayErrorFilter());
  await nestApp.init();
  await app.ready();
  return app;
}
