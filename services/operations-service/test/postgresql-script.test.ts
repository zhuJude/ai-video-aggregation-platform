import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

const executeFile = promisify(execFile);
const operationsRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

it('makes the mandatory PostgreSQL CI entry fail when its database URL is missing', async () => {
  const env = { ...process.env };
  delete env.OPERATIONS_TEST_DATABASE_URL;
  const failure: unknown = await executeFile(
    process.execPath,
    [join(operationsRoot, 'scripts', 'test-postgresql.mjs')],
    { cwd: operationsRoot, env },
  ).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  const commandError = failure as Error & { code?: number; stderr?: string };
  expect(commandError.code).toBe(1);
  expect(commandError.stderr).toContain('OPERATIONS_TEST_DATABASE_URL is required');
});

it('resolves the Vitest CLI through exported package metadata', () => {
  const script = readFileSync(join(operationsRoot, 'scripts', 'test-postgresql.mjs'), 'utf8');
  expect(script).toContain("import.meta.resolve('vitest/package.json')");
  expect(script).not.toContain("import.meta.resolve('vitest/vitest.mjs')");
});
