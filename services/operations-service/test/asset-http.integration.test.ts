import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HttpAssetAuthorizationGateway,
  FileWorkloadIdentityToken,
} from '../src/adapters/asset-authorization.gateway.js';

const ASSET = '01990f24-2ba2-7000-8000-000000000002';
const USER = '01990f24-2ba2-7000-8000-000000000001';
const directories: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => terminate(child)));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('operations to asset HTTP integration', () => {
  it('crosses a real process HTTP boundary with projected workload identity', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'support-workload-'));
    directories.push(directory);
    const tokenFile = join(directory, 'token');
    await writeFile(tokenFile, 'projected-token\n', { mode: 0o600 });

    const child = spawnAssetSandbox();
    children.push(child);
    const port = await childPort(child);
    const gateway = new HttpAssetAuthorizationGateway(
      new URL(`http://127.0.0.1:${String(port)}`),
      new FileWorkloadIdentityToken(tokenFile),
      500,
    );

    await expect(gateway.findAvailableAsset(ASSET)).resolves.toEqual({
      id: ASSET,
      ownerId: USER,
    });
  }, 15_000);
});

function spawnAssetSandbox(): ChildProcess {
  const moduleUrl = pathToFileURL(resolve('../asset-service/src/http/asset-http.module.ts')).href;
  const runtimeUrl = pathToFileURL(resolve('../asset-service/src/runtime/asset.runtime.ts')).href;
  const source = `
    const { AssetHttpModule } = await import(${JSON.stringify(moduleUrl)});
    const { AssetMetrics, AssetReadiness, PeriodicAssetWorkers, startAssetService } = await import(${JSON.stringify(runtimeUrl)});
    const http = new AssetHttpModule({
      resultImport: { import() { throw new Error('unused'); } },
      lifecycle: { requestUserDeletion() { throw new Error('unused'); }, restoreUserDeletion() { throw new Error('unused'); } },
      uploadSessions: { create() { throw new Error('unused'); }, complete() { throw new Error('unused'); }, createDownload() { throw new Error('unused'); } },
      internalAssets: {
        findAvailableAsset(id) { return Promise.resolve(id === ${JSON.stringify(ASSET)} ? { id, ownerId: ${JSON.stringify(USER)} } : null); },
        reserve() { throw new Error('unused'); }, finalize() { throw new Error('unused'); }, release() { throw new Error('unused'); }, lookup() { throw new Error('unused'); },
      },
      userAuthenticator: { authenticate() { return Promise.resolve(null); } },
      serviceAuthenticator: { authenticate(headers) { return Promise.resolve(headers.authorization === 'Bearer projected-token' ? { userId: 'operations-service' } : null); } },
      providerCallbackAuthenticator: { authenticate() { return Promise.resolve(null); } },
      providerTaskAuthorization: { authorize() { return Promise.resolve(null); } },
    });
    const runtime = await startAssetService({
      http,
      readiness: new AssetReadiness({ database: { ping() { return Promise.resolve(); } }, objectStore: { ping() { return Promise.resolve(); } }, kms: { ping() { return Promise.resolve(); } }, ram: { ping() { return Promise.resolve(); } }, auth: { ping() { return Promise.resolve(); } }, broker: { ping() { return Promise.resolve(); } }, config: { environment: 'test', bucket: 'private', region: 'cn-shanghai', ramRoleArn: 'acs:ram::123:role/asset', kmsKeyReference: 'kms://asset/key', publicRead: false } }),
      metrics: new AssetMetrics({ gauges: { pendingDeletions() { return Promise.resolve(0); }, pendingImports() { return Promise.resolve(0); } } }),
      workers: new PeriodicAssetWorkers({ lifecycle: { run() { return Promise.resolve(); } }, outbox: { run() { return Promise.resolve(0); } }, intervalMs: 60000 }),
    });
    const address = runtime.server.server.address();
    process.stdout.write(JSON.stringify({ port: address.port }) + '\\n');
    const close = async () => { await runtime.close(); process.exit(0); };
    process.once('SIGTERM', close);
    process.once('SIGINT', close);
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: resolve('../asset-service/tsconfig.json'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function childPort(child: ChildProcess): Promise<number> {
  return new Promise((resolvePort, reject) => {
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      reject(new Error(`asset sandbox timeout: ${stderr}`));
    }, 15_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timeout);
      try {
        const parsed = JSON.parse(stdout.slice(0, newline)) as { port: number };
        resolvePort(parsed.port);
      } catch (error) {
        reject(error instanceof Error ? error : new Error('invalid child response'));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`asset sandbox exited ${String(code)}: ${stderr}`));
    });
  });
}

function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolveExit) => {
    const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(force);
      resolveExit();
    });
    child.kill('SIGTERM');
  });
}
