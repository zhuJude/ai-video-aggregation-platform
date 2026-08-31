import { lookup } from 'node:dns/promises';
import { pathToFileURL } from 'node:url';
import { Redis } from 'ioredis';
import { createGatewayApp, type ReadinessResult } from './app.js';

interface RuntimeConfig {
  readonly adminJwtPublicKeys: string;
  readonly allowedOrigins: string[];
  readonly gatewaySigningPrivateKey: string;
  readonly host: string;
  readonly port: number;
  readonly redisUrl: string;
  readonly serviceDnsNames: string[];
  readonly trustProxyCidrs: string[];
  readonly userJwtPublicKeys: string;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (value === undefined || value.length === 0)
    throw new Error(`missing required setting: ${name}`);
  return value;
}

function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('invalid PORT');
  const allowedOrigins = csv(required(env, 'CORS_ALLOWED_ORIGINS'));
  const serviceDnsNames = csv(required(env, 'SERVICE_DNS_NAMES'));
  const trustProxyCidrs = csv(required(env, 'TRUST_PROXY_CIDRS'));
  if (allowedOrigins.length === 0 || serviceDnsNames.length === 0 || trustProxyCidrs.length === 0) {
    throw new Error('runtime allowlists must not be empty');
  }
  return {
    adminJwtPublicKeys: required(env, 'ADMIN_JWT_PUBLIC_KEYS'),
    allowedOrigins,
    gatewaySigningPrivateKey: required(env, 'GATEWAY_SIGNING_PRIVATE_KEY'),
    host: env.HOST?.trim() || '0.0.0.0',
    port,
    redisUrl: required(env, 'REDIS_URL'),
    serviceDnsNames,
    trustProxyCidrs,
    userJwtPublicKeys: required(env, 'USER_JWT_PUBLIC_KEYS'),
  };
}

function withProbeTimeout(operation: Promise<unknown>, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
    void operation.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function createReadinessProbe(config: RuntimeConfig, redis: Redis): () => Promise<ReadinessResult> {
  return async () => {
    const redisReady = await withProbeTimeout(redis.ping());
    const dnsChecks = await Promise.all(
      config.serviceDnsNames.map((hostname) => withProbeTimeout(lookup(hostname))),
    );
    const checks = {
      redis: redisReady,
      serviceDns: dnsChecks.every(Boolean),
      signingKeys:
        config.adminJwtPublicKeys.length > 0 &&
        config.userJwtPublicKeys.length > 0 &&
        config.gatewaySigningPrivateKey.length > 0,
    };
    return { checks, ok: Object.values(checks).every(Boolean) };
  };
}

export async function bootstrap(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadRuntimeConfig(env);
  const redis = new Redis(config.redisUrl, {
    enableOfflineQueue: false,
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });
  redis.on('error', () => undefined);
  const app = await createGatewayApp({
    allowedOrigins: config.allowedOrigins,
    readiness: createReadinessProbe(config, redis),
    trustProxy: config.trustProxyCidrs,
  });
  app.addHook('onClose', () => {
    redis.disconnect(false);
    return Promise.resolve();
  });
  await app.listen({ host: config.host, port: config.port });

  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void app.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void bootstrap().catch(() => {
    process.stderr.write('edge-gateway failed to start\n');
    process.exitCode = 1;
  });
}
