import { pathToFileURL } from 'node:url';
import {
  ProviderRuntimeController,
  ProviderRuntimeMetrics,
  createProviderRuntimeServer,
  type ReadinessProbe,
  type ProviderBusinessRuntime,
} from './operations.js';
import { createProductionProviderComposition } from './production-composition.js';
import { requiredSecretList } from './auth.js';

const REQUIRED_DEPENDENCIES = {
  adapter_registry: 'READINESS_ADAPTER_REGISTRY_URL',
  database: 'READINESS_DATABASE_URL',
  message_bus: 'READINESS_MESSAGE_BUS_URL',
} as const;

export interface ProviderRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly readinessUrls: Readonly<Record<keyof typeof REQUIRED_DEPENDENCIES, URL>>;
  readonly internalServiceAuthTokens: readonly string[];
}

/** Composition code must pass this observer to execution, polling and circuit handlers. */
export type ProviderBusinessBootstrap = (
  observer: ProviderRuntimeMetrics,
  environment: Readonly<Record<string, string | undefined>>,
) => Promise<ProviderBusinessRuntime>;

export function loadProviderRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderRuntimeConfig {
  return {
    host: environment.HOST?.trim() || '0.0.0.0',
    port: parsePort(environment.PORT, 3001),
    readinessUrls: Object.fromEntries(
      Object.entries(REQUIRED_DEPENDENCIES).map(([name, setting]) => [
        name,
        parseReadinessUrl(environment[setting]),
      ]),
    ) as unknown as ProviderRuntimeConfig['readinessUrls'],
    internalServiceAuthTokens: requiredSecretList(
      environment,
      'INTERNAL_SERVICE_AUTH_TOKENS',
      'INTERNAL_SERVICE_AUTH_TOKEN',
    ),
  };
}

export async function bootstrapProviderRuntime(
  environment: Readonly<Record<string, string | undefined>> = process.env,
  businessBootstrap: ProviderBusinessBootstrap = (observer, runtimeEnvironment) =>
    createProductionProviderComposition(runtimeEnvironment, observer),
): Promise<void> {
  const configuration = loadProviderRuntimeConfig(environment);
  const metrics = new ProviderRuntimeMetrics();
  const businessRuntime = await businessBootstrap(metrics, environment);
  const probes = Object.fromEntries(
    Object.entries(configuration.readinessUrls).map(([name, url]) => [name, httpProbe(url)]),
  ) as Readonly<Record<string, ReadinessProbe>>;
  const runtime = createProviderRuntimeServer(
    new ProviderRuntimeController(metrics, probes),
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

function httpProbe(url: URL): ReadinessProbe {
  return async () => {
    const response = await fetch(url, {
      headers: { accept: 'application/json' },
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(400),
    });
    return response.ok;
  };
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
  void bootstrapProviderRuntime().catch(() => {
    process.stderr.write('provider-runtime failed to start\n');
    process.exitCode = 1;
  });
}
