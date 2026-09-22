import { spawnSync } from 'node:child_process';

export function runWorkspaceCommand(args: readonly string[]): void {
  const command = process.platform === 'win32' ? 'corepack.cmd' : 'corepack';
  const result = spawnSync(command, ['pnpm', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
    shell: process.platform === 'win32',
    timeout: 15 * 60 * 1_000,
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n');
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed (${String(result.status)}):\n${output}`);
  }
}
