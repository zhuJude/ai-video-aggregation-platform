import { acquireVerificationLock } from './verify-lock.mjs';
import {
  getSharedVerificationLockPath,
  runVerificationWorkflow,
} from './verification-workflow.mjs';

const lockPath = getSharedVerificationLockPath();
let lastWaitNotice = 0;
const lock = await acquireVerificationLock(lockPath, {
  onWait(owner) {
    if (Date.now() - lastWaitNotice < 10_000) return;
    lastWaitNotice = Date.now();
    console.log(
      `Verification queued behind PID ${owner?.pid ?? 'unknown'} in ${owner?.cwd ?? 'unknown'}`,
    );
  },
});

try {
  runVerificationWorkflow();
} finally {
  await lock.release();
}
