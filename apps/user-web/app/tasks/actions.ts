'use server';

import { classifyCancelTaskError, taskGateway } from '../../lib/tasks/gateway';
import { requireFixtureServerSession } from '../../lib/auth/server-session';
import { parseRetryDraft, parseTaskStatusSnapshot } from '../../lib/tasks/runtime';
import type { CancelTaskResult } from '../../lib/tasks/types';

export async function cancelTaskAction(
  taskId: string,
  idempotencyKey: string,
): Promise<CancelTaskResult> {
  try {
    const session = await requireFixtureServerSession();
    const snapshot = parseTaskStatusSnapshot(
      await taskGateway.cancelTask(taskId, { idempotencyKey, ownerId: session.ownerId }),
    );
    return { ok: true, snapshot };
  } catch (error) {
    return { ok: false, outcome: classifyCancelTaskError(error) };
  }
}

export async function createRetryDraftAction(
  taskId: string,
): Promise<{ readonly draftId: string }> {
  const session = await requireFixtureServerSession();
  return parseRetryDraft(await taskGateway.createRetryDraft(taskId, { ownerId: session.ownerId }));
}
