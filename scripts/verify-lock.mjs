import { randomUUID } from 'node:crypto';
import { open, readFile, unlink } from 'node:fs/promises';

function defaultIsProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'));
  } catch {
    return undefined;
  }
}

export async function tryAcquireVerificationLock(
  lockPath,
  {
    pid = process.pid,
    cwd = process.cwd(),
    isProcessAlive = defaultIsProcessAlive,
    recoveryAttempted = false,
  } = {},
) {
  const token = randomUUID();
  try {
    const handle = await open(lockPath, 'wx');
    await handle.writeFile(
      JSON.stringify({ pid, cwd, token, acquiredAt: new Date().toISOString() }),
      'utf8',
    );
    await handle.close();

    return {
      acquired: true,
      async release() {
        const owner = await readOwner(lockPath);
        if (owner?.token !== token) return;
        await unlink(lockPath).catch((error) => {
          if (error?.code !== 'ENOENT') throw error;
        });
      },
    };
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  const owner = await readOwner(lockPath);
  const ownerIsAlive = Number.isInteger(owner?.pid) && isProcessAlive(owner.pid);
  if (!ownerIsAlive && !recoveryAttempted) {
    await unlink(lockPath).catch((error) => {
      if (error?.code !== 'ENOENT') throw error;
    });
    return tryAcquireVerificationLock(lockPath, {
      pid,
      cwd,
      isProcessAlive,
      recoveryAttempted: true,
    });
  }

  return { acquired: false, owner };
}

export async function acquireVerificationLock(
  lockPath,
  { timeoutMs = 30 * 60 * 1000, pollMs = 2_000, onWait = () => undefined } = {},
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await tryAcquireVerificationLock(lockPath);
    if (result.acquired) return result;
    onWait(result.owner);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new Error(`Timed out waiting for verification lock: ${lockPath}`);
}
