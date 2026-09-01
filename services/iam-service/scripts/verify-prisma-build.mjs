import { spawnSync } from 'node:child_process';
import { log } from 'node:console';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const serviceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const generatedSource = join(serviceRoot, 'src', 'generated', 'prisma');
const dist = join(serviceRoot, 'dist');
const generatedDist = join(dist, 'src', 'generated', 'prisma');
for (const target of [generatedSource, dist]) rmSync(target, { recursive: true, force: true });

const pnpmCli = process.env['npm_execpath'];
if (!pnpmCli) throw new Error('PNPM_EXECUTABLE_UNAVAILABLE');
const build = spawnSync(process.execPath, [pnpmCli, 'run', 'build'], {
  cwd: serviceRoot,
  env: process.env,
  stdio: 'inherit',
});
if (build.status !== 0) throw new Error(`IAM_BUILD_FAILED: ${String(build.status ?? 'unknown')}`);

for (const artifact of [
  join(generatedSource, 'index.js'),
  join(generatedSource, 'runtime', 'client.js'),
  join(generatedSource, 'query_compiler_fast_bg.wasm'),
  join(generatedDist, 'index.js'),
  join(generatedDist, 'package.json'),
  join(generatedDist, 'runtime', 'client.js'),
  join(generatedDist, 'query_compiler_fast_bg.wasm'),
]) {
  if (!existsSync(artifact)) {
    throw new Error(`MISSING_PRISMA_BUILD_ARTIFACT: ${relative(serviceRoot, artifact)}`);
  }
}
log('IAM Prisma clean build verification passed.');
