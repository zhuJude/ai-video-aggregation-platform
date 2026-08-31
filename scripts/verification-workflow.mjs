import { execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export function getSharedVerificationLockPath(cwd = process.cwd()) {
  const commonGitDirectory = execFileSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd, encoding: 'utf8' },
  ).trim();
  return resolve(commonGitDirectory, 'ai-video-verify.lock');
}

export function runPnpm(args, cwd = process.cwd()) {
  const pnpmCli = process.env.npm_execpath;
  const result = pnpmCli
    ? spawnSync(process.execPath, [pnpmCli, ...args], { cwd, env: process.env, stdio: 'inherit' })
    : spawnSync(process.platform === 'win32' ? 'corepack.cmd' : 'corepack', ['pnpm', ...args], {
        cwd,
        env: process.env,
        stdio: 'inherit',
      });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function runVerificationWorkflow(cwd = process.cwd()) {
  for (const script of ['format:check', 'lint', 'typecheck', 'test', 'build']) {
    runPnpm([script], cwd);
  }
}
