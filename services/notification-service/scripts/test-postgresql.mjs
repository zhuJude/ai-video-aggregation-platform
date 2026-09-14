import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (!process.env.NOTIFICATION_TEST_DATABASE_URL) {
  console.error('NOTIFICATION_TEST_DATABASE_URL is required');
  process.exit(1);
}
const vitest = fileURLToPath(import.meta.resolve('vitest/vitest.mjs'));
const prisma = fileURLToPath(import.meta.resolve('prisma/build/index.js'));
const migrate = spawnSync(process.execPath, [prisma, 'migrate', 'deploy'], {
  stdio: 'inherit',
  env: { ...process.env, DATABASE_URL: process.env.NOTIFICATION_TEST_DATABASE_URL },
});
if (migrate.status !== 0) process.exit(migrate.status ?? 1);
const result = spawnSync(
  process.execPath,
  [vitest, 'run', 'test/prisma-notification.repository.pg.test.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: process.env.NOTIFICATION_TEST_DATABASE_URL },
  },
);
process.exit(result.status ?? 1);
