/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-unused-vars -- Nest adapter framework signatures. */
import 'reflect-metadata';
import { randomBytes } from 'node:crypto';
import {
  All,
  Controller,
  Get,
  Inject,
  Module,
  Req,
  Res,
  type DynamicModule,
  type NestApplicationOptions,
  type RequestMethod,
  type VersioningOptions,
} from '@nestjs/common';
import { AbstractHttpAdapter } from '@nestjs/core/adapters/http-adapter';
import { NestFactory } from '@nestjs/core';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { NotificationHttpRequest } from '../http/notification-http.module.js';
import { NotificationHttpModule } from '../http/notification-http.module.js';
import type { NotificationWorkerRunner } from '../application/notification.consumer.js';

const HTTP = Symbol('NOTIFICATION_HTTP');
const READINESS = Symbol('NOTIFICATION_READINESS');
const uuid = {
  type: 'string',
  format: 'uuid',
  pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$',
};
const apiError = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message', 'traceId', 'retryable'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    traceId: { type: 'string', pattern: '^[a-f0-9]{32}$' },
    retryable: { type: 'boolean' },
  },
};
const errorResponse = {
  description: 'ApiError',
  content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
};

export const NOTIFICATION_OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Notification Service API', version: '1.0.0' },
  paths: {
    '/health/live': {
      get: { operationId: 'liveness', responses: { '200': { description: 'Live' } } },
    },
    '/health/ready': {
      get: {
        operationId: 'readiness',
        responses: {
          '200': { description: 'Ready' },
          '503': {
            description: 'Unavailable',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiError' } } },
          },
        },
      },
    },
    '/openapi.json': {
      get: { operationId: 'openapi', responses: { '200': { description: 'OpenAPI' } } },
    },
    '/v1/inbox': {
      get: {
        operationId: 'listInbox',
        security: [{ bearerAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: {
          '200': {
            description: 'Inbox page',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/InboxPage' } } },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
    '/v1/inbox/{id}/read': {
      post: {
        operationId: 'markInboxRead',
        security: [{ bearerAuth: [] }],
        parameters: [{ name: 'id', in: 'path', required: true, schema: uuid }],
        responses: {
          '200': {
            description: 'Inbox message',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/InboxMessage' } },
            },
          },
          '400': errorResponse,
          '401': errorResponse,
          '404': errorResponse,
        },
      },
    },
  },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
    schemas: {
      ApiError: apiError,
      UuidV7: uuid,
      InboxMessage: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'notificationId', 'userId', 'title', 'body', 'readAt', 'createdAt'],
        properties: {
          id: uuid,
          notificationId: uuid,
          userId: uuid,
          title: { type: 'string' },
          body: { type: 'string' },
          readAt: { oneOf: [{ type: 'string', format: 'date-time' }, { type: 'null' }] },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      InboxPage: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/InboxMessage' },
          },
          nextCursor: { type: 'string' },
        },
      },
    },
  },
} as const;

@Controller()
class NotificationController {
  constructor(
    @Inject(HTTP) private readonly http: NotificationHttpModule,
    @Inject(READINESS) private readonly readiness: () => Promise<boolean>,
  ) {}
  @Get('/health/live') live(): { status: string } {
    return { status: 'ok' };
  }
  @Get('/health/ready') async ready(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      if (await this.readiness()) {
        void reply.send({ status: 'ready' });
        return;
      }
    } catch {
      /* readiness failure */
    }
    const incoming = request.headers['x-trace-id'];
    const traceId =
      typeof incoming === 'string' && /^[a-f0-9]{32}$/.test(incoming)
        ? incoming
        : randomBytes(16).toString('hex');
    void reply.status(503).header('x-trace-id', traceId).send({
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'DEPENDENCY_UNAVAILABLE',
      traceId,
      retryable: true,
    });
  }
  @Get('/openapi.json') document(): typeof NOTIFICATION_OPENAPI {
    return NOTIFICATION_OPENAPI;
  }
  @All('{*path}') async dispatch(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const response = await this.http.handle({
      method: request.method,
      path: request.url.split('?')[0] ?? request.url,
      headers: request.headers as NotificationHttpRequest['headers'],
      query: request.query as Record<string, unknown>,
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    for (const [name, value] of Object.entries(response.headers)) void reply.header(name, value);
    void reply.status(response.status).send(response.body);
  }
}

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class NotificationRuntimeModule {
  static register(input: {
    http: NotificationHttpModule;
    readiness: () => Promise<boolean>;
  }): DynamicModule {
    return {
      module: NotificationRuntimeModule,
      controllers: [NotificationController],
      providers: [
        { provide: HTTP, useValue: input.http },
        { provide: READINESS, useValue: input.readiness },
      ],
    };
  }
}

class LockedFastifyAdapter extends AbstractHttpAdapter<any, FastifyRequest, FastifyReply> {
  constructor(private readonly fastify = Fastify({ logger: false })) {
    super(fastify);
  }
  initHttpServer(_options: NestApplicationOptions): void {
    this.httpServer = this.fastify.server;
  }
  override listen(
    port: string | number,
    hostOrCallback?: string | (() => void),
    callback?: () => void,
  ): Promise<string> {
    const host = typeof hostOrCallback === 'string' ? hostOrCallback : '0.0.0.0';
    const done = typeof hostOrCallback === 'function' ? hostOrCallback : callback;
    return this.fastify.listen({ port: Number(port), host }).then((address) => {
      done?.();
      return address;
    });
  }
  close(): Promise<void> {
    return this.fastify.close();
  }
  override all(path: any, handler?: any): any {
    return handler === undefined
      ? this.fastify.all('/*', path)
      : this.fastify.all(routePath(path), handler);
  }
  override get(path: any, handler?: any): any {
    return handler === undefined
      ? this.fastify.get('/*', path)
      : this.fastify.get(routePath(path), handler);
  }
  useStaticAssets(): never {
    throw new Error('STATIC_ASSETS_NOT_SUPPORTED');
  }
  setViewEngine(): never {
    throw new Error('VIEWS_NOT_SUPPORTED');
  }
  getRequestHostname(request: FastifyRequest): string {
    return request.hostname;
  }
  getRequestMethod(request: FastifyRequest): string {
    return request.method;
  }
  getRequestUrl(request: FastifyRequest): string {
    return request.url;
  }
  status(response: FastifyReply, statusCode: number): FastifyReply {
    return response.status(statusCode);
  }
  reply(response: FastifyReply, body: any, statusCode?: number): FastifyReply {
    if (statusCode !== undefined) void response.status(statusCode);
    return response.send(body);
  }
  end(response: FastifyReply, message?: string): FastifyReply {
    return response.send(message);
  }
  render(): never {
    throw new Error('VIEWS_NOT_SUPPORTED');
  }
  redirect(response: FastifyReply, statusCode: number, url: string): FastifyReply {
    return response.redirect(url, statusCode);
  }
  setErrorHandler(_handler: Function): void {
    this.fastify.setErrorHandler((_error, request, reply) =>
      apiFailure(request, reply, 500, 'INTERNAL_ERROR', true),
    );
  }
  setNotFoundHandler(_handler: Function): void {
    this.fastify.setNotFoundHandler((request, reply) =>
      apiFailure(request, reply, 404, 'ROUTE_NOT_FOUND', false),
    );
  }
  isHeadersSent(response: FastifyReply): boolean {
    return response.sent;
  }
  getHeader(response: FastifyReply, name: string): unknown {
    return response.getHeader(name);
  }
  setHeader(response: FastifyReply, name: string, value: string): FastifyReply {
    return response.header(name, value);
  }
  appendHeader(response: FastifyReply, name: string, value: string): FastifyReply {
    response.raw.appendHeader(name, value);
    return response;
  }
  registerParserMiddleware(): void {}
  enableCors(): void {}
  createMiddlewareFactory(_method: RequestMethod): (path: string, callback: Function) => void {
    return (path, callback) => {
      this.fastify.all(routePath(path), (request, reply) =>
        callback(request, reply, () => undefined),
      );
    };
  }
  getType(): string {
    return 'fastify';
  }
  applyVersionFilter(
    handler: Function,
    _version: unknown,
    _options: VersioningOptions,
  ): (request: FastifyRequest, response: FastifyReply, next: () => void) => Function {
    return handler as (
      request: FastifyRequest,
      response: FastifyReply,
      next: () => void,
    ) => Function;
  }
}
function routePath(path: unknown): string {
  return (typeof path === 'string' ? path : '/').replace('{*path}', '*');
}
function apiFailure(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  code: string,
  retryable: boolean,
): FastifyReply {
  const incoming = request.headers['x-trace-id'];
  const traceId =
    typeof incoming === 'string' && /^[a-f0-9]{32}$/.test(incoming)
      ? incoming
      : randomBytes(16).toString('hex');
  return reply
    .status(status)
    .header('x-trace-id', traceId)
    .send({ code, message: code, traceId, retryable });
}

export async function bootstrapNotificationRuntime(input: {
  http: NotificationHttpModule;
  readiness: () => Promise<boolean>;
  workerRunner: NotificationWorkerRunner;
  host?: string;
  port?: number;
}): Promise<{ server: FastifyInstance; close(): Promise<void> }> {
  const adapter = new LockedFastifyAdapter();
  const app = await NestFactory.create(NotificationRuntimeModule.register(input), adapter, {
    logger: ['error', 'warn'],
  });
  await app.listen(input.port ?? 0, input.host ?? '0.0.0.0');
  input.workerRunner.start();
  return {
    server: adapter.getInstance<FastifyInstance>(),
    close: async () => {
      await input.workerRunner.stop();
      await app.close();
    },
  };
}
