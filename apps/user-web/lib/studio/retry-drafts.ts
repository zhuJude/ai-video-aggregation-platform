import type { RetryDraft } from '../tasks/types';

const drafts = new Map<string, RetryDraft>();

export function saveRetryDraft(draft: RetryDraft): void {
  drafts.set(draft.id, {
    ...draft,
    parameters: structuredClone(draft.parameters),
  });
}

export function readRetryDraft(draftId: string): RetryDraft | undefined {
  const draft = drafts.get(draftId);
  return draft ? { ...draft, parameters: structuredClone(draft.parameters) } : undefined;
}
