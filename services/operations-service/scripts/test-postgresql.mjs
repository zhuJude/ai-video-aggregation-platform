import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.OPERATIONS_TEST_DATABASE_URL) {
  console.error('OPERATIONS_TEST_DATABASE_URL is required');
  process.exit(1);
}

const vitestPackagePath = fileURLToPath(import.meta.resolve('vitest/package.json'));
const vitestPackage = JSON.parse(readFileSync(vitestPackagePath, 'utf8'));
const vitestBin = vitestPackage.bin?.vitest;
if (typeof vitestBin !== 'string') throw new Error('Vitest CLI entry is missing');
const vitest = resolve(dirname(vitestPackagePath), vitestBin);
const prisma = fileURLToPath(import.meta.resolve('prisma/build/index.js'));
const databaseEnv = {
  ...process.env,
  DATABASE_URL: process.env.OPERATIONS_TEST_DATABASE_URL,
};
const generate = spawnSync(process.execPath, [prisma, 'generate'], {
  stdio: 'inherit',
  env: databaseEnv,
});
if (generate.status !== 0) process.exit(generate.status ?? 1);
const result = spawnSync(
  process.execPath,
  [vitest, 'run', 'test/prisma-ticket.repository.pg.test.ts'],
  { stdio: 'inherit', env: databaseEnv },
);
process.exit(result.status ?? 1);
