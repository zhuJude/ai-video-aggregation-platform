import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tryAcquireVerificationLock } from './verify-lock.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function createLockPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'ai-video-verify-lock-'));
  temporaryDirectories.push(directory);
  return join(directory, 'verify.lock');
}

describe('verification lock', () => {
  it('allows only one live verification owner at a time', async () => {
    const lockPath = await createLockPath();
    const first = await tryAcquireVerificationLock(lockPath, {
      pid: 101,
      cwd: 'first-worktree',
      isProcessAlive: () => true,
    });
    expect(first.acquired).toBe(true);

    const second = await tryAcquireVerificationLock(lockPath, {
      pid: 202,
      cwd: 'second-worktree',
      isProcessAlive: () => true,
    });
    expect(second).toMatchObject({ acquired: false, owner: { pid: 101 } });

    if (first.acquired) await first.release();
    const third = await tryAcquireVerificationLock(lockPath, {
      pid: 202,
      cwd: 'second-worktree',
      isProcessAlive: () => true,
    });
    expect(third.acquired).toBe(true);
    if (third.acquired) await third.release();
  });

  it('recovers a lock whose owner process is no longer alive', async () => {
    const lockPath = await createLockPath();
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 999_999, cwd: 'stale-worktree', token: 'stale' }),
      'utf8',
    );

    const result = await tryAcquireVerificationLock(lockPath, {
      pid: 303,
      cwd: 'current-worktree',
      isProcessAlive: () => false,
    });

    expect(result.acquired).toBe(true);
    if (result.acquired) await result.release();
  });
});
