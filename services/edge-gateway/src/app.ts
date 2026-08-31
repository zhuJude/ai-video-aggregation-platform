import 'reflect-metadata';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import { Body, Controller, Get, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { traceMiddleware } from '@repo/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GatewayErrorFilter } from './http/error-handler.js';
import { buildOpenApiDocument } from './http/openapi.js';
import { GatewayMetrics } from './runtime/metrics.js';

export interface ReadinessResult {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly ok: boolean;
}

export interface GatewayAppOptions {
  readonly allowedOrigins?: readonly string[];
  readonly configure?: (app: FastifyInstance) => Promise<void> | void;
  readonly exposeTestRoutes?: boolean;
  readonly metrics?: GatewayMetrics;
  readonly readiness?: () => Promise<ReadinessResult>;
  readonly trustProxy?: boolean | string | string[];
}

@Controller('test')
class TestErrorController {
  @Get('error')
  error(): never {
    throw new Error('secret-upstream-url');
  }

  @Post('body')
  body(@Body() body: unknown): unknown {
    return body;
  }

  @Get('request-ip')
  requestIp(@Req() request: FastifyRequest): { ip: string } {
    return { ip: request.ip };
  }
}

export async function createGatewayApp(options: GatewayAppOptions = {}): Promise<FastifyInstance> {
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
  const metrics = options.metrics ?? new GatewayMetrics();
  const readiness =
    options.readiness ??
    (() => Promise.resolve({ checks: { bootstrap: true }, ok: true } satisfies ReadinessResult));
  const requestStartedAt = new WeakMap<FastifyRequest, number>();

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
  app.addHook('onRequest', (request) => {
    requestStartedAt.set(request, performance.now());
    return Promise.resolve();
  });
  app.addHook('onResponse', (request, reply) => {
    const startedAt = requestStartedAt.get(request) ?? performance.now();
    metrics.observeRoute(
      request.method,
      request.routeOptions.url || 'unmatched',
      reply.statusCode,
      (performance.now() - startedAt) / 1000,
    );
    return Promise.resolve();
  });
  app.get('/openapi.json', () => Promise.resolve(buildOpenApiDocument()));
  app.get('/health/live', () => Promise.resolve({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    const result = await readiness();
    return reply.status(result.ok ? 200 : 503).send(result);
  });
  app.get('/metrics', (_request, reply) =>
    Promise.resolve(reply.type('text/plain; version=0.0.4; charset=utf-8').send(metrics.render())),
  );
  await options.configure?.(app);
  nestApp.useGlobalFilters(new GatewayErrorFilter());
  await nestApp.init();
  await app.ready();
  return app;
}
