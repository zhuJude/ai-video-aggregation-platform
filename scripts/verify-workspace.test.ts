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
      'vitest run scripts/verify-workspace.test.ts scripts/validate-compose.test.ts scripts/verify-lock.test.ts',
    );
    expect(packageJson.scripts?.test).toBe('pnpm test:root && turbo run test');
    expect(packageJson.scripts?.verify).toBe('node scripts/verify.mjs');

    const verificationEntry = await readFile('scripts/verify.mjs', 'utf8');
    const verificationWorkflow = await readFile('scripts/verification-workflow.mjs', 'utf8');
    expect(verificationEntry).toContain('runVerificationWorkflow()');
    expect(verificationWorkflow).toContain(
      "['format:check', 'lint', 'typecheck', 'test', 'build']",
    );
  });

  it('runs workspace and Compose verification in CI', async () => {
    const workflow = await readFile('.github/workflows/ci.yml', 'utf8');

    expect(workflow).toContain('- run: corepack pnpm verify');
    expect(workflow).toContain('- run: docker compose -f infra/local/compose.yaml config --quiet');
  });
});
