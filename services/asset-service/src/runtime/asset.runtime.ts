/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-function-type, @typescript-eslint/no-unused-vars, @typescript-eslint/restrict-template-expressions, @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-unnecessary-condition -- Nest owns adapter signatures; Prometheus renders validated numeric values. */
export interface HealthDependency {
  ping(): Promise<void>;
}

const ASSET_HTTP = Symbol('ASSET_HTTP');
const ASSET_READINESS = Symbol('ASSET_READINESS');
const ASSET_METRICS = Symbol('ASSET_METRICS');

export class ReadinessError extends Error {
  readonly code = 'DEPENDENCY_UNAVAILABLE';
  constructor() {
    super('DEPENDENCY_UNAVAILABLE');
    this.name = 'ReadinessError';
  }
}

export interface AssetRuntimeConfig {
  environment: string;
  bucket: string;
  region: string;
  ramRoleArn: string;
  kmsKeyReference: string;
  publicRead: boolean;
}

export class AssetReadiness {
  readonly config: AssetRuntimeConfig;
  private readonly database: HealthDependency;
  private readonly objectStore: HealthDependency;
  private readonly kms: HealthDependency;
  private readonly ram: HealthDependency;
  private readonly auth: HealthDependency;
  private readonly broker: HealthDependency;
  private readonly timeoutMs: number;

  constructor(input: {
    database: HealthDependency;
    objectStore: HealthDependency;
    kms: HealthDependency;
    ram: HealthDependency;
    auth: HealthDependency;
    broker: HealthDependency;
    config: AssetRuntimeConfig;
    timeoutMs?: number;
  }) {
    this.database = input.database;
    this.objectStore = input.objectStore;
    this.kms = input.kms;
    this.ram = input.ram;
    this.auth = input.auth;
    this.broker = input.broker;
    this.config = input.config;
    this.timeoutMs = input.timeoutMs ?? 2_000;
  }

  async check(): Promise<{
    database: 'ok';
    objectStore: 'ok';
    kms: 'ok';
    ram: 'ok';
    auth: 'ok';
    broker: 'ok';
    config: 'ok';
  }> {
    validateAssetConfig(this.config);
    await withTimeout(
      Promise.all([
        boundedPing(this.database, this.timeoutMs),
        boundedPing(this.objectStore, this.timeoutMs),
        boundedPing(this.kms, this.timeoutMs),
        boundedPing(this.ram, this.timeoutMs),
        boundedPing(this.auth, this.timeoutMs),
        boundedPing(this.broker, this.timeoutMs),
      ]),
      this.timeoutMs,
    );
    return {
      database: 'ok',
      objectStore: 'ok',
      kms: 'ok',
      ram: 'ok',
      auth: 'ok',
      broker: 'ok',
      config: 'ok',
    };
  }
}

export class AssetMetrics {
  private readonly uploadFailures = new Map<string, number>();
  private readonly importFailures = new Map<string, number>();
  private importedBytes = 0;

  constructor(
    private readonly input: {
      gauges: {
        pendingDeletions(): Promise<number>;
        pendingImports(): Promise<number>;
      };
    },
  ) {}

  uploadCompletionFailed(reason: 'signature' | 'size' | 'mime' | 'storage' | 'unknown'): void {
    increment(this.uploadFailures, reason);
  }

  importCompleted(bytes: number): void {
    if (Number.isSafeInteger(bytes) && bytes >= 0) this.importedBytes += bytes;
  }

  importFailed(reason: 'network' | 'policy' | 'checksum' | 'storage' | 'unknown'): void {
    increment(this.importFailures, reason);
  }

  async render(): Promise<string> {
    const [pendingDeletions, pendingImports] = await Promise.all([
      this.input.gauges.pendingDeletions(),
      this.input.gauges.pendingImports(),
    ]);
    return [
      '# TYPE support_asset_upload_completion_failures_total counter',
      ...labeledCounters(
        'support_asset_upload_completion_failures_total',
        'reason',
        this.uploadFailures,
      ),
      '# TYPE support_asset_import_bytes_total counter',
      `support_asset_import_bytes_total ${this.importedBytes}`,
      '# TYPE support_asset_import_errors_total counter',
      ...labeledCounters('support_asset_import_errors_total', 'reason', this.importFailures),
      '# TYPE support_asset_pending_deletions gauge',
      `support_asset_pending_deletions ${safeGauge(pendingDeletions)}`,
      '# TYPE support_asset_pending_imports gauge',
      `support_asset_pending_imports ${safeGauge(pendingImports)}`,
      '',
    ].join('\n');
  }
}

export class PeriodicAssetWorkers {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly input: {
      lifecycle: { run(): Promise<void> };
      outbox: { run(): Promise<number> };
      intervalMs?: number;
      stopTimeoutMs?: number;
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await settleWithTimeout(this.inFlight, this.input.stopTimeoutMs ?? 25_000);
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.input.lifecycle.run();
      await this.input.outbox.run();
    } catch (error) {
      this.input.onError?.(error);
    }
    if (this.running) this.schedule(this.input.intervalMs ?? 1_000);
  }
}

@Controller()
class AssetController {
  constructor(
    @Inject(ASSET_HTTP) private readonly http: AssetHttpModule,
    @Inject(ASSET_READINESS) private readonly readiness: AssetReadiness,
    @Inject(ASSET_METRICS) private readonly metrics: AssetMetrics,
  ) {}

  @Get('/health/live') live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('/health/ready') async ready(
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    try {
      await this.readiness.check();
      void reply.send({ status: 'ready' });
    } catch {
      void sendApiError(request, reply, 503, 'DEPENDENCY_UNAVAILABLE', true);
    }
  }

  @Get('/metrics') async prometheus(@Res() reply: FastifyReply): Promise<void> {
    void reply
      .header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
      .send(await this.metrics.render());
  }

  @All('{*path}') async dispatch(
    @Req() request: FastifyRequest & { rawBody?: Uint8Array },
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const response = await this.http.handle({
      method: request.method,
      path: request.url.split('?')[0] ?? request.url,
      headers: request.headers as NonNullable<AssetHttpRequest['headers']>,
      ...(request.rawBody === undefined ? {} : { rawBody: request.rawBody }),
      ...(request.body === undefined ? {} : { body: request.body }),
    });
    void reply.status(response.status).send(response.body);
  }
}

@Module({})
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class AssetRuntimeModule {
  static register(input: {
    http: AssetHttpModule;
    readiness: AssetReadiness;
    metrics: AssetMetrics;
  }): DynamicModule {
    return {
      module: AssetRuntimeModule,
      controllers: [AssetController],
      providers: [
        { provide: ASSET_HTTP, useValue: input.http },
        { provide: ASSET_READINESS, useValue: input.readiness },
        { provide: ASSET_METRICS, useValue: input.metrics },
      ],
    };
  }
}

class LockedFastifyAdapter extends AbstractHttpAdapter<any, FastifyRequest, FastifyReply> {
  constructor(private readonly fastify = Fastify({ logger: false })) {
    super(fastify);
    this.fastify.addContentTypeParser(
      'application/json',
      { parseAs: 'buffer' },
      (request, body, done) => {
        try {
          const raw = typeof body === 'string' ? Buffer.from(body) : body;
          (request as FastifyRequest & { rawBody: Uint8Array }).rawBody = raw;
          done(null, JSON.parse(raw.toString('utf8')) as unknown);
        } catch (error) {
          done(error as Error);
        }
      },
    );
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
      sendApiError(request, reply, 500, 'INTERNAL_ERROR', true),
    );
  }
  setNotFoundHandler(_handler: Function): void {
    this.fastify.setNotFoundHandler((request, reply) =>
      sendApiError(request, reply, 404, 'ROUTE_NOT_FOUND', false),
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

export async function startAssetService(input: {
  http: AssetHttpModule;
  readiness: AssetReadiness;
  metrics: AssetMetrics;
  workers: PeriodicAssetWorkers;
  workersEnabled?: boolean;
  host?: string;
  port?: number;
}): Promise<{ server: FastifyInstance; close(): Promise<void> }> {
  const adapter = new LockedFastifyAdapter();
  const app = await NestFactory.create(AssetRuntimeModule.register(input), adapter, {
    logger: ['error', 'warn'],
  });
  app.enableShutdownHooks();
  await app.listen(input.port ?? 0, input.host ?? '0.0.0.0');
  if (input.workersEnabled ?? true) input.workers.start();
  return {
    server: adapter.getInstance<FastifyInstance>(),
    close: async () => {
      if (input.workersEnabled ?? true) await input.workers.stop();
      await app.close();
    },
  };
}

function validateAssetConfig(config: AssetRuntimeConfig): void {
  const referencesValid =
    config.bucket.length > 0 &&
    config.region.length > 0 &&
    /^acs:ram::[^:]+:role\/.+/.test(config.ramRoleArn) &&
    /^kms:\/\/.+/.test(config.kmsKeyReference);
  if (!referencesValid || (config.environment !== 'local' && config.publicRead)) {
    throw new ReadinessError();
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ReadinessError()), timeoutMs);
      }),
    ]);
  } catch {
    throw new ReadinessError();
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function boundedPing(dependency: HealthDependency, timeoutMs: number): Promise<void> {
  return withTimeout(
    Promise.resolve().then(() => dependency.ping()),
    timeoutMs,
  );
}

async function settleWithTimeout(operation: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    operation.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
}

function increment(values: Map<string, number>, key: string): void {
  values.set(key, (values.get(key) ?? 0) + 1);
}

function labeledCounters(
  name: string,
  label: string,
  values: ReadonlyMap<string, number>,
): string[] {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${name}{${label}="${key}"} ${value}`);
}

function safeGauge(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function routePath(path: unknown): string {
  return (typeof path === 'string' ? path : '/').replace('{*path}', '*');
}

function sendApiError(
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
import type { AssetHttpModule, AssetHttpRequest } from '../http/asset-http.module.js';
