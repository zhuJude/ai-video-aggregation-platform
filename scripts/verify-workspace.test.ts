import { access, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const required = [
  'pnpm-workspace.yaml',
  'turbo.json',
  'tsconfig.base.json',
  'packages/contracts/package.json',
  'packages/service-kit/package.json',
] as const;

describe('workspace', () => {
  it.each(required)('contains %s', async (path) => {
    await expect(access(path)).resolves.toBeUndefined();
  });

  it('runs root smoke tests through the normal test command', async () => {
    const packageJson = JSON.parse(await readFile('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.['test:root']).toBe(
      'vitest run scripts/verify-workspace.test.ts scripts/validate-compose.test.ts',
    );
    expect(packageJson.scripts?.test).toBe('pnpm test:root && turbo run test');
    expect(packageJson.scripts?.verify).toContain('pnpm test');
  });

  it('runs workspace and Compose verification in CI', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('- run: corepack pnpm verify');
    expect(workflow).toContain('- run: docker compose -f infra/local/compose.yaml config --quiet');
  });
});
