import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const require = createRequire(import.meta.url);
const prismaPackage = require.resolve('prisma/package.json');
const prismaCli = resolve(dirname(prismaPackage), 'build', 'index.js');
const result = spawnSync(process.execPath, [prismaCli, 'generate'], {
  cwd: resolve(import.meta.dirname, '..'),
  env: {
    ...process.env,
    DATABASE_URL: 'postgresql://prisma-generate@127.0.0.1:5432/prisma-generate',
  },
  stdio: 'inherit',
});
if (result.error !== undefined) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
