import type { RetryDraft } from '../tasks/types';

// Backend-unmerged fixture only; WS09's persistent authenticated Gateway replaces this Map.
export const FIXTURE_SESSION_OWNER_ID = 'fixture-session-current-user';

interface RetryDraftAccess {
  readonly now?: number;
  readonly ownerId: string;
}

interface RetryDraftSaveOptions extends RetryDraftAccess {
  readonly ttlMs?: number;
}

interface StoredRetryDraft {
  readonly draft: RetryDraft;
  readonly expiresAt: number;
  readonly ownerId: string;
}

const DEFAULT_TTL_MS = 10 * 60 * 1_000;
const drafts = new Map<string, StoredRetryDraft>();

export function saveRetryDraft(draft: RetryDraft, options: RetryDraftSaveOptions): void {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error('INVALID_RETRY_DRAFT_EXPIRY');
  }
  drafts.set(draft.id, {
    draft: { ...draft, parameters: structuredClone(draft.parameters) },
    expiresAt: now + ttlMs,
    ownerId: options.ownerId,
  });
}

export function readRetryDraft(draftId: string, options: RetryDraftAccess): RetryDraft | undefined {
  const stored = drafts.get(draftId);
  if (!stored) return undefined;
  const now = options.now ?? Date.now();
  if (stored.expiresAt <= now) {
    drafts.delete(draftId);
    return undefined;
  }
  if (stored.ownerId !== options.ownerId) return undefined;
  drafts.delete(draftId);
  return { ...stored.draft, parameters: structuredClone(stored.draft.parameters) };
}
