/* eslint-disable @typescript-eslint/no-confusing-void-expression -- concise test doubles return settled promises. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  AssetMetrics,
  AssetReadiness,
  PeriodicAssetWorkers,
  startAssetService,
} from '../src/runtime/asset.runtime.js';
import { AssetHttpModule } from '../src/http/asset-http.module.js';
import { UploadSessionError } from '../src/application/upload-session.service.js';

describe('asset production runtime', () => {
  it('checks the database and required private OSS/KMS configuration with a timeout', async () => {
    const kms = { ping: vi.fn().mockResolvedValue(undefined) };
    const ram = { ping: vi.fn().mockResolvedValue(undefined) };
    const auth = { ping: vi.fn().mockResolvedValue(undefined) };
    const broker = { ping: vi.fn().mockResolvedValue(undefined) };
    const readiness = new AssetReadiness({
      database: { ping: vi.fn().mockResolvedValue(undefined) },
      objectStore: { ping: vi.fn().mockResolvedValue(undefined) },
      kms,
      ram,
      auth,
      broker,
      config: {
        environment: 'production',
        bucket: 'private-assets',
        region: 'cn-shanghai',
        ramRoleArn: 'acs:ram::123456789:role/asset-service',
        kmsKeyReference: 'kms://asset/provider-callback',
        publicRead: false,
      },
      timeoutMs: 20,
    });
    await expect(readiness.check()).resolves.toEqual({
      database: 'ok',
      objectStore: 'ok',
      kms: 'ok',
      ram: 'ok',
      auth: 'ok',
      broker: 'ok',
      config: 'ok',
    });
    expect(
      [kms.ping, ram.ping, auth.ping, broker.ping].every((ping) => ping.mock.calls.length === 1),
    ).toBe(true);

    const timedOut = new AssetReadiness({
      database: { ping: () => new Promise(() => undefined) },
      objectStore: { ping: vi.fn().mockResolvedValue(undefined) },
      kms,
      ram,
      auth,
      broker,
      config: readiness.config,
      timeoutMs: 5,
    });
    await expect(timedOut.check()).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('exports bounded Prometheus metrics without sensitive or high-cardinality labels', async () => {
    const metrics = new AssetMetrics({
      gauges: {
        pendingDeletions: () => Promise.resolve(3),
        pendingImports: () => Promise.resolve(2),
      },
    });
    metrics.uploadCompletionFailed('signature');
    metrics.importCompleted(1_024);
    metrics.importFailed('network');
    const output = await metrics.render();
    expect(output).toContain(
      'support_asset_upload_completion_failures_total{reason="signature"} 1',
    );
    expect(output).toContain('support_asset_import_bytes_total 1024');
    expect(output).toContain('support_asset_pending_deletions 3');
    expect(output).not.toMatch(/object[_ ]?key|owner[_ ]?id|user[_ ]?id/i);
  });

  it('starts lifecycle/import recovery/outbox drivers and drains them on shutdown', async () => {
    const lifecycle = { run: vi.fn().mockResolvedValue(undefined) };
    const outbox = { run: vi.fn().mockResolvedValue(0) };
    const workers = new PeriodicAssetWorkers({
      lifecycle,
      outbox,
      intervalMs: 5,
      stopTimeoutMs: 100,
    });
    workers.start();
    await vi.waitFor(() => expect(lifecycle.run).toHaveBeenCalled());
    await vi.waitFor(() => expect(outbox.run).toHaveBeenCalled());
    await workers.stop();
    const calls = lifecycle.run.mock.calls.length;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
    expect(lifecycle.run).toHaveBeenCalledTimes(calls);
  });

  it('serves live, concrete ready and Prometheus probes from Nest', async () => {
    const metrics = new AssetMetrics({
      gauges: {
        pendingDeletions: () => Promise.resolve(0),
        pendingImports: () => Promise.resolve(0),
      },
    });
    const runtime = await startAssetService({
      http: new AssetHttpModule({
        resultImport: { import: vi.fn() },
        lifecycle: { requestUserDeletion: vi.fn(), restoreUserDeletion: vi.fn() },
        uploadSessions: {
          create: vi.fn(),
          complete: vi
            .fn()
            .mockRejectedValue(new UploadSessionError('INVALID_FILE_SIGNATURE', 'invalid')),
          createDownload: vi.fn(),
        },
        userAuthenticator: {
          authenticate: () => Promise.resolve({ userId: '01990f24-2ba2-7000-8000-000000000001' }),
        },
        providerCallbackAuthenticator: { authenticate: vi.fn() },
        providerTaskAuthorization: { authorize: vi.fn() },
        metrics,
      }),
      readiness: new AssetReadiness({
        database: { ping: () => Promise.resolve() },
        objectStore: { ping: () => Promise.resolve() },
        kms: { ping: () => Promise.resolve() },
        ram: { ping: () => Promise.resolve() },
        auth: { ping: () => Promise.resolve() },
        broker: { ping: () => Promise.resolve() },
        config: {
          environment: 'production',
          bucket: 'private',
          region: 'cn-shanghai',
          ramRoleArn: 'acs:ram::123:role/asset',
          kmsKeyReference: 'kms://asset/key',
          publicRead: false,
        },
      }),
      metrics,
      workers: new PeriodicAssetWorkers({
        lifecycle: { run: () => Promise.resolve() },
        outbox: { run: () => Promise.resolve(0) },
        intervalMs: 60_000,
      }),
    });
    try {
      expect((await runtime.server.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(
        200,
      );
      expect(
        (await runtime.server.inject({ method: 'GET', url: '/health/ready' })).statusCode,
      ).toBe(200);
      expect(
        (
          await runtime.server.inject({
            method: 'POST',
            url: '/v1/upload-sessions/01990f24-2ba2-7000-8000-000000000003/complete',
            payload: { objectKey: 'uploads/key', mimeType: 'image/png', sizeBytes: '8' },
          })
        ).statusCode,
      ).toBe(422);
      const response = await runtime.server.inject({ method: 'GET', url: '/metrics' });
      expect(response.headers['content-type']).toContain('text/plain');
      expect(response.body).toContain('support_asset_pending_deletions 0');
      expect(response.body).toContain(
        'support_asset_upload_completion_failures_total{reason="signature"} 1',
      );
    } finally {
      await runtime.close();
    }
  });

  it('ships a non-root multi-stage image with a real healthcheck and no baked secrets', async () => {
    const dockerfile = await readFile(resolve(import.meta.dirname, '../Dockerfile'), 'utf8');
    const packageJson = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(dockerfile.match(/^FROM /gm)?.length).toBeGreaterThanOrEqual(3);
    expect(dockerfile).toContain('corepack pnpm');
    expect(dockerfile).toContain('pnpm install --lockfile=false --ignore-scripts');
    expect(dockerfile).not.toMatch(/--offline|--frozen-lockfile/);
    expect(dockerfile).not.toContain('COPY . .');
    expect(dockerfile).toContain('deploy --legacy --prod');
    expect(dockerfile).not.toMatch(/^COPY services\/asset-service services\/asset-service$/m);
    expect(dockerfile).not.toMatch(
      /COPY .*\.(?:env|log)|COPY .*node_modules|COPY .*coverage|COPY services\/asset-service\/dist/i,
    );
    expect(dockerfile).toContain('prisma-generate.mjs');
    expect(dockerfile).not.toContain('DATABASE_URL=');
    expect(dockerfile).not.toContain('COPY packages/contracts packages/contracts');
    expect(dockerfile).toContain('COPY packages/contracts/src packages/contracts/src');
    expect(dockerfile).toContain(
      'COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json',
    );
    expect(dockerfile).toMatch(/^USER \d+$/m);
    expect(dockerfile).toContain('/health/ready');
    expect(dockerfile).not.toMatch(/(ACCESS_KEY_SECRET|SECRET_ACCESS_KEY|BEGIN PRIVATE KEY)\s*=/i);
    expect(packageJson.scripts.start).toBe('node dist/src/main.js');
    expect(packageJson.scripts.build).toBe(
      'node scripts/prisma-generate.mjs && tsc -p tsconfig.json',
    );
    expect(packageJson.scripts.typecheck).toBe(
      'node scripts/prisma-generate.mjs && tsc -p tsconfig.json --noEmit',
    );
    expect(packageJson.scripts.lint).toBe('node scripts/prisma-generate.mjs && eslint src test');
    const prismaGenerate = await readFile(
      resolve(import.meta.dirname, '../scripts/prisma-generate.mjs'),
      'utf8',
    );
    expect(prismaGenerate).toContain('postgresql://prisma-generate@127.0.0.1:5432/prisma-generate');
    expect(prismaGenerate).toContain('process.execPath');
    await expect(
      readFile(resolve(import.meta.dirname, '../src/main.ts'), 'utf8'),
    ).resolves.toContain('startAssetService');
  });
});
