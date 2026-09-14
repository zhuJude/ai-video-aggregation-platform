/* eslint-disable @typescript-eslint/no-confusing-void-expression -- concise test doubles return settled promises. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  OperationsMetrics,
  OperationsReadiness,
  OperationsWorkerRunner,
} from '../src/runtime/production.js';

describe('operations production runtime', () => {
  it('uses concrete database readiness and times it out', async () => {
    await expect(
      new OperationsReadiness({
        database: { ping: () => Promise.resolve() },
        broker: { ping: () => Promise.resolve() },
        auth: { ping: () => Promise.resolve() },
        asset: { ping: () => Promise.resolve() },
        generation: { ping: () => Promise.resolve() },
        timeoutMs: 20,
      }).check(),
    ).resolves.toEqual({
      database: 'ok',
      broker: 'ok',
      auth: 'ok',
      asset: 'ok',
      generation: 'ok',
    });
    await expect(
      new OperationsReadiness({
        database: { ping: () => new Promise(() => undefined) },
        broker: { ping: () => Promise.resolve() },
        auth: { ping: () => Promise.resolve() },
        asset: { ping: () => Promise.resolve() },
        generation: { ping: () => Promise.resolve() },
        timeoutMs: 5,
      }).check(),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('exports CMS, ticket backlog and compensation metrics with bounded labels', async () => {
    const metrics = new OperationsMetrics({
      gauges: {
        ticketBacklog: () => Promise.resolve({ open: 4, inProgress: 2 }),
        pendingCompensations: () => Promise.resolve(1),
      },
    });
    metrics.publication('content', 'published');
    const output = await metrics.render();
    expect(output).toContain(
      'support_operations_cms_publications_total{kind="content",result="published"} 1',
    );
    expect(output).toContain('support_operations_ticket_backlog{status="open"} 4');
    expect(output).toContain('support_operations_pending_compensations 1');
    expect(output).not.toMatch(/user[_ ]?id|ticket[_ ]?id|asset[_ ]?id/i);
  });

  it('drives the outbox and ticket attachment compensation until graceful stop', async () => {
    const outbox = { run: vi.fn().mockResolvedValue(0) };
    const compensation = { run: vi.fn().mockResolvedValue(0) };
    const runner = new OperationsWorkerRunner({
      outbox,
      compensation,
      intervalMs: 5,
      stopTimeoutMs: 100,
    });
    runner.start();
    await vi.waitFor(() => expect(outbox.run).toHaveBeenCalled());
    await vi.waitFor(() => expect(compensation.run).toHaveBeenCalled());
    await runner.stop();
  });

  it('ships a non-root multi-stage image with the production start contract', async () => {
    const dockerfile = await readFile(resolve(import.meta.dirname, '../Dockerfile'), 'utf8');
    const packageJson = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(dockerfile.match(/^FROM /gm)?.length).toBeGreaterThanOrEqual(3);
    expect(dockerfile).toContain('pnpm install --lockfile=false --ignore-scripts');
    expect(dockerfile).not.toMatch(/--offline|--frozen-lockfile/);
    expect(dockerfile).not.toContain('COPY . .');
    expect(dockerfile).toContain('deploy --legacy --prod');
    expect(dockerfile).not.toMatch(
      /^COPY services\/operations-service services\/operations-service$/m,
    );
    expect(dockerfile).not.toMatch(
      /COPY .*\.(?:env|log)|COPY .*node_modules|COPY .*coverage|COPY services\/operations-service\/dist/i,
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
    expect(packageJson.scripts.lint).toBe(
      'node scripts/prisma-generate.mjs && eslint src test prisma.config.ts',
    );
    const prismaGenerate = await readFile(
      resolve(import.meta.dirname, '../scripts/prisma-generate.mjs'),
      'utf8',
    );
    expect(prismaGenerate).toContain('postgresql://prisma-generate@127.0.0.1:5432/prisma-generate');
    expect(prismaGenerate).toContain('process.execPath');
    await expect(
      readFile(resolve(import.meta.dirname, '../src/main.ts'), 'utf8'),
    ).resolves.toContain('startOperationsService');
  });
});
