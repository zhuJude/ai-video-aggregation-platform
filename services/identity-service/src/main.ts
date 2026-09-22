import 'reflect-metadata';
import { pathToFileURL } from 'node:url';
import { createIdentityApplication, type IdentityCloudInfrastructure } from './app.js';
import { parseIdentityEnvironment, type IdentityEnvironment } from './config/environment.js';
import { IdentityResourceLifecycle } from './operational/resource-lifecycle.js';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';

export interface IdentityBootstrapOptions {
  readonly environment?: IdentityEnvironment;
  readonly cloudFactory?: (
    environment: IdentityEnvironment,
  ) => Promise<IdentityCloudInfrastructure>;
  readonly manageSignals?: boolean;
}

export async function bootstrap(
  options: IdentityBootstrapOptions = {},
): Promise<NestFastifyApplication> {
  const environment = options.environment ?? parseIdentityEnvironment(process.env);
  const lifecycle = new IdentityResourceLifecycle();
  let app: NestFastifyApplication | undefined;
  try {
    const cloud = options.cloudFactory ? await options.cloudFactory(environment) : undefined;
    if (cloud)
      lifecycle.register('cloud', async () => {
        await cloud.close();
        process.stdout.write(
          `${JSON.stringify({ level: 'info', event: 'identity_cloud_resources_closed' })}\n`,
        );
      });
    const created = await createIdentityApplication({
      environment,
      lifecycle,
      ...(cloud ? { cloud } : {}),
    });
    app = created.app;
    await app.listen(environment.port, environment.host);
    if (options.manageSignals !== false) installSignalHandlers(app);
    process.stdout.write(
      `${JSON.stringify({ level: 'info', event: 'identity_service_started' })}\n`,
    );
    return app;
  } catch (error) {
    if (app) {
      try {
        await app.close();
      } catch {
        /* The shared lifecycle below completes all remaining once-disposers. */
      }
    }
    try {
      await lifecycle.close();
    } catch {
      /* Preserve the original startup error; lifecycle already emitted a safe aggregate. */
    }
    throw error;
  }
}

function installSignalHandlers(app: NestFastifyApplication): void {
  let closing = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const)
    process.once(signal, () => {
      if (closing) return;
      closing = true;
      void gracefulShutdown(app, signal)
        .then(() => {
          process.exitCode = 0;
        })
        .catch(() => {
          process.exitCode = 1;
        });
    });
}

export async function gracefulShutdown(
  app: NestFastifyApplication,
  signal: 'SIGTERM' | 'SIGINT',
): Promise<void> {
  process.stdout.write(
    `${JSON.stringify({ level: 'info', event: 'identity_service_stopping', signal })}\n`,
  );
  await app.close();
}

function isEntrypoint(): boolean {
  const script = process.argv[1];
  return typeof script === 'string' && import.meta.url === pathToFileURL(script).href;
}

if (isEntrypoint()) {
  bootstrap().catch((error: unknown) => {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? String(Reflect.get(error, 'code'))
        : 'IDENTITY_STARTUP_FAILED';
    process.stderr.write(
      `${JSON.stringify({ level: 'fatal', event: 'identity_service_start_failed', code })}\n`,
    );
    process.exitCode = 1;
  });
}
