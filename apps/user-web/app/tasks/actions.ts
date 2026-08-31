'use server';

import { classifyCancelTaskError, taskGateway } from '../../lib/tasks/gateway';
import { parseRetryDraft, parseTaskStatusSnapshot } from '../../lib/tasks/runtime';
import type { CancelTaskResult } from '../../lib/tasks/types';

export async function cancelTaskAction(
  taskId: string,
  idempotencyKey: string,
): Promise<CancelTaskResult> {
  try {
    const snapshot = parseTaskStatusSnapshot(
      await taskGateway.cancelTask(taskId, { idempotencyKey }),
    );
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, outcome: classifyCancelTaskError(error) };
  }
}

export async function createRetryDraftAction(
  taskId: string,
): Promise<{ readonly draftId: string }> {
  return parseRetryDraft(await taskGateway.createRetryDraft(taskId));
}
