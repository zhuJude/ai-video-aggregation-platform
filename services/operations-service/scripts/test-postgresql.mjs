import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.OPERATIONS_TEST_DATABASE_URL) {
  console.error('OPERATIONS_TEST_DATABASE_URL is required');
  process.exit(1);
}

const vitest = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));
const result = spawnSync(process.execPath, [vitest, 'run', 'test/prisma-ticket.repository.pg.test.ts'], { stdio: 'inherit', env: process.env });
process.exit(result.status ?? 1);
