'use server';

import { taskGateway } from '../../lib/tasks/gateway';
import { parseRetryDraft, parseTaskStatusSnapshot } from '../../lib/tasks/runtime';
import type { TaskStatusSnapshot } from '../../lib/tasks/types';

export async function cancelTaskAction(
  taskId: string,
  idempotencyKey: string,
): Promise<TaskStatusSnapshot> {
  return parseTaskStatusSnapshot(await taskGateway.cancelTask(taskId, { idempotencyKey }));
}

export async function createRetryDraftAction(
  taskId: string,
): Promise<{ readonly draftId: string }> {
  return parseRetryDraft(await taskGateway.createRetryDraft(taskId));
}
