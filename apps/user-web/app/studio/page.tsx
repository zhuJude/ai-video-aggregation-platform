import { StudioWorkspaceEntry } from '../../components/studio/studio-workspace-entry';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { readRetryDraft } from '../../lib/studio/retry-drafts';
import { isUuidV7 } from '../../lib/tasks/identifiers';
import { redirect } from 'next/navigation';

interface StudioPageProps {
  readonly searchParams: Promise<{
    readonly draft?: string | string[];
    readonly model?: string | string[];
  }>;
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export default async function StudioPage({ searchParams }: StudioPageProps) {
  const { draft, model } = await searchParams;
  const draftId = typeof draft === 'string' && isUuidV7(draft) ? draft : undefined;
  const modelId = typeof model === 'string' && MODEL_ID.test(model) ? model : undefined;
  const query = new URLSearchParams();
  if (draftId) query.set('draft', draftId);
  if (modelId) query.set('model', modelId);
  const returnTo = `/studio${query.size ? `?${query.toString()}` : ''}`;
  const sessionState = await readAuthenticatedServerSessionState();
  if (sessionState.kind === 'needs-refresh') {
    redirect(`/auth/session/refresh?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (sessionState.kind !== 'active') {
    redirect(`/login?returnTo=${encodeURIComponent(returnTo)}`);
  }
  const session = sessionState.session;
  const retryDraft = draftId ? readRetryDraft(draftId, { ownerId: session.ownerId }) : undefined;
  return (
    <StudioWorkspaceEntry
      initialModelId={modelId}
      retryDraft={retryDraft}
      retryDraftRequested={typeof draft === 'string'}
    />
  );
}
