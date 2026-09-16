import { pathToFileURL } from 'node:url';
import {
  GenerationMetrics,
  GenerationRuntimeController,
  createGenerationRuntimeServer,
  type ReadinessProbe,
  type GenerationBusinessRuntime,
} from './operations.js';
import { createProductionGenerationComposition } from './production-composition.js';
import { requiredSecretList } from './auth.js';

const REQUIRED_DEPENDENCIES = {
  asset: 'READINESS_ASSET_URL',
  database: 'READINESS_DATABASE_URL',
  message_bus: 'READINESS_MESSAGE_BUS_URL',
  routing: 'READINESS_ROUTING_URL',
  wallet: 'READINESS_WALLET_URL',
} as const;

export interface GenerationRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly readinessUrls: Readonly<
    Record<keyof typeof REQUIRED_DEPENDENCIES | 'provider_runtime', URL>
  >;
  readonly internalServiceAuthTokens: readonly string[];
}

/** Composition code must pass this observer to every mounted domain handler. */
export type GenerationBusinessBootstrap = (
  observer: GenerationMetrics,
  environment: Readonly<Record<string, string | undefined>>,
) => Promise<GenerationBusinessRuntime>;

export function loadGenerationRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): GenerationRuntimeConfig {
  return {
    host: environment.HOST?.trim() || '0.0.0.0',
    port: parsePort(environment.PORT, 3000),
    readinessUrls: Object.fromEntries([
      ...Object.entries(REQUIRED_DEPENDENCIES).map(
        ([name, setting]) => [name, parseReadinessUrl(environment[setting])] as const,
      ),
      [
        'provider_runtime',
        new URL('health/ready', parseServiceBaseUrl(environment.PROVIDER_RUNTIME_API_URL)),
      ],
    ]) as unknown as GenerationRuntimeConfig['readinessUrls'],
    internalServiceAuthTokens: requiredSecretList(
      environment,
      'INTERNAL_SERVICE_AUTH_TOKENS',
      'INTERNAL_SERVICE_AUTH_TOKEN',
    ),
  };
}

export async function bootstrapGenerationRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  businessBootstrap: GenerationBusinessBootstrap = (observer, runtimeEnvironment) =>
    createProductionGenerationComposition(runtimeEnvironment, observer),
): Promise<void> {
  const configuration = loadGenerationRuntimeConfig(environment);
  const metrics = new GenerationMetrics();
  const businessRuntime = await businessBootstrap(metrics, environment);
  const probes = Object.fromEntries(
    Object.entries(configuration.readinessUrls).map(([name, url]) => [
      name,
      httpProbe(
        url,
        name === 'provider_runtime' ? configuration.internalServiceAuthTokens[0] : undefined,
      ),
    ]),
  ) as Readonly<Record<string, ReadinessProbe>>;
  const runtime = createGenerationRuntimeServer(
    new GenerationRuntimeController(metrics, probes),
    businessRuntime,
    { internalServiceAuthTokens: configuration.internalServiceAuthTokens },
  );
  await runtime.listen(configuration.port, configuration.host);
  installShutdown(() => runtime.close());
}

function parsePort(value: string | undefined, fallback: number): number {
  const port = Number(value ?? String(fallback));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('INVALID_PORT');
  return port;
}

function parseReadinessUrl(value: string | undefined): URL {
  try {
    if (value === undefined || value.trim().length === 0) throw new Error('missing');
    const url = new URL(value);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      throw new Error('unsafe');
    }
    return url;
  } catch {
    throw new Error('INVALID_READINESS_URL');
  }
}

function httpProbe(url: URL, token?: string): ReadinessProbe {
  return async () => {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(400),
    });
    return response.ok;
  };
}

function parseServiceBaseUrl(value: string | undefined): URL {
  const url = parseReadinessUrl(value);
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`);
}

function installShutdown(close: () => Promise<void>): void {
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void bootstrapGenerationRuntime().catch(() => {
    process.stderr.write('generation-service failed to start\n');
    process.exitCode = 1;
  });
}
