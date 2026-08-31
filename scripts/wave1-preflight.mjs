import { acquireVerificationLock } from './verify-lock.mjs';
import {
  getSharedVerificationLockPath,
  runPnpm,
  runVerificationWorkflow,
} from './verification-workflow.mjs';

const lockPath = getSharedVerificationLockPath();
let lastWaitNotice = 0;
const lock = await acquireVerificationLock(lockPath, {
  onWait(owner) {
    if (Date.now() - lastWaitNotice < 10_000) return;
    lastWaitNotice = Date.now();
    console.log(
      `Wave 1 preflight queued behind PID ${owner?.pid ?? 'unknown'} in ${owner?.cwd ?? 'unknown'}`,
    );
  },
});

try {
  runPnpm(['install', '--lockfile=false']);
  runVerificationWorkflow();
  runPnpm(['audit', '--audit-level', 'high']);
} finally {
  await lock.release();
}
