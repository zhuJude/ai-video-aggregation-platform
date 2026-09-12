'use server';

import { classifyCancelTaskError, taskGateway } from '../../lib/tasks/gateway';
import {
  requireMutableAuthenticatedServerSession,
  SessionRefreshRequiredError,
} from '../../lib/auth/server-session';
import { parseRetryDraft, parseTaskDetail, parseTaskStatusSnapshot } from '../../lib/tasks/runtime';
import type { CancelTaskResult, RetryDraftActionResult } from '../../lib/tasks/types';
import { commerceGateway } from '../../lib/commerce/gateway';
import { parseSignedAssetUrl } from '../../lib/commerce/runtime';

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

export async function requestTaskResultAccessAction(
  taskId: string,
  purpose: 'PREVIEW' | 'DOWNLOAD',
): Promise<
  | { readonly ok: true; readonly url: string; readonly expiresAt: string }
  | { readonly ok: false; readonly outcome: 'SESSION_REFRESH_REQUIRED' | 'DEFINITIVE_FAILURE' }
> {
  try {
    const session = await requireMutableAuthenticatedServerSession();
    const detail = parseTaskDetail(await taskGateway.getTask(taskId, session));
    if (detail.statusSnapshot.status !== 'SETTLED' || !detail.result) {
      return { ok: false, outcome: 'DEFINITIVE_FAILURE' };
    }
    const access = parseSignedAssetUrl(
      await commerceGateway.requestAssetAccess(detail.result.assetId, purpose, session),
    );
    return { ok: true, ...access };
  } catch (error) {
    return {
      ok: false,
      outcome:
        error instanceof SessionRefreshRequiredError
          ? 'SESSION_REFRESH_REQUIRED'
          : 'DEFINITIVE_FAILURE',
    };
  }
}
