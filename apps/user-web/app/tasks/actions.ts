'use server';

import { classifyCancelTaskError, taskGateway } from '../../lib/tasks/gateway';
import {
  requireMutableAuthenticatedServerSession,
  SessionRefreshRequiredError,
} from '../../lib/auth/server-session';
import { parseRetryDraft, parseTaskStatusSnapshot } from '../../lib/tasks/runtime';
import type { CancelTaskResult, RetryDraftActionResult } from '../../lib/tasks/types';

export async function cancelTaskAction(
  taskId: string,
  idempotencyKey: string,
): Promise<CancelTaskResult> {
  try {
    const session = await requireMutableAuthenticatedServerSession();
    const snapshot = parseTaskStatusSnapshot(
      await taskGateway.cancelTask(taskId, { idempotencyKey, ownerId: session.ownerId }),
    );
    return { ok: true, snapshot };
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      return { ok: false, outcome: 'SESSION_REFRESH_REQUIRED' };
    }
    return { ok: false, outcome: classifyCancelTaskError(error) };
  }
}

export async function createRetryDraftAction(taskId: string): Promise<RetryDraftActionResult> {
  try {
    const session = await requireMutableAuthenticatedServerSession();
    const draft = parseRetryDraft(
      await taskGateway.createRetryDraft(taskId, { ownerId: session.ownerId }),
    );
    return { ok: true, draftId: draft.draftId };
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      return { ok: false, outcome: 'SESSION_REFRESH_REQUIRED' };
    }
    throw error;
  }
}
