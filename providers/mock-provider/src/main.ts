import { pathToFileURL } from 'node:url';
import { createMockProviderServer } from './server.js';
import type { CallbackDelivery } from './protocol.js';

export interface MockProviderRuntimeConfig {
  readonly host: string;
  readonly port: number;
  readonly callbackUrl: URL;
  readonly callbackTimeoutMs: number;
  readonly callbackMaxAttempts: number;
}

export function loadMockProviderRuntimeConfig(
  environment: Readonly<Record<string, string | undefined>>,
): MockProviderRuntimeConfig {
  const rawTarget = environment.MOCK_PROVIDER_CALLBACK_URL?.trim();
  if (rawTarget === undefined || rawTarget.length === 0) {
    throw new Error('MOCK_CALLBACK_TARGET_REQUIRED');
  }
  let callbackUrl: URL;
  try {
    callbackUrl = new URL(rawTarget);
  } catch {
    throw new Error('INVALID_MOCK_CALLBACK_TARGET');
  }
  if (
    (callbackUrl.protocol !== 'http:' && callbackUrl.protocol !== 'https:') ||
    callbackUrl.username.length > 0 ||
    callbackUrl.password.length > 0
  ) {
    throw new Error('INVALID_MOCK_CALLBACK_TARGET');
  }
  return {
    host: environment.HOST?.trim() || '0.0.0.0',
    port: boundedInteger(environment.PORT, 3002, 1, 65_535),
    callbackUrl,
    callbackTimeoutMs: boundedInteger(
      environment.MOCK_PROVIDER_CALLBACK_TIMEOUT_MS,
      1_000,
      1,
      60_000,
    ),
    callbackMaxAttempts: boundedInteger(environment.MOCK_PROVIDER_CALLBACK_MAX_ATTEMPTS, 3, 1, 10),
  };
}

export function createHttpCallbackDelivery(
  callbackUrl: URL,
  timeoutMs: number,
): (delivery: CallbackDelivery, context: { signal: AbortSignal }) => Promise<void> {
  return async (delivery, context) => {
    const response = await fetch(callbackUrl, {
      method: 'POST',
      redirect: 'error',
      headers: {
        ...delivery.headers,
        'content-type': 'application/json',
      },
      body: delivery.rawBody.toString('utf8'),
      signal: AbortSignal.any([context.signal, AbortSignal.timeout(timeoutMs)]),
    });
    if (!response.ok) throw new Error('CALLBACK_TARGET_REJECTED');
  };
}

export async function bootstrapMockProvider(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  const configuration = loadMockProviderRuntimeConfig(environment);
  const server = await createMockProviderServer({
    environment,
    callbackDeliveryTimeoutMs: configuration.callbackTimeoutMs,
    callbackMaxAttempts: configuration.callbackMaxAttempts,
    deliverCallback: createHttpCallbackDelivery(
      configuration.callbackUrl,
      configuration.callbackTimeoutMs,
    ),
  });
  await server.listen(configuration.port, configuration.host);
  let closing = false;
  const shutdown = (): void => {
    if (closing) return;
    closing = true;
    void server.close().finally(() => {
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function boundedInteger(
  raw: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(raw ?? String(fallback));
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error('INVALID_MOCK_PROVIDER_CONFIGURATION');
  }
  return value;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void bootstrapMockProvider().catch(() => {
    process.stderr.write('mock-provider failed to start\n');
    process.exitCode = 1;
  });
}
