import { StudioWorkspace } from '../../components/studio/studio-workspace';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { readRetryDraft } from '../../lib/studio/retry-drafts';
import { isUuidV7 } from '../../lib/tasks/identifiers';
import { clientStudioGateway } from '../../lib/studio/client-gateway';
import { redirect } from 'next/navigation';

interface StudioPageProps {
  readonly searchParams: Promise<{ readonly draft?: string | string[] }>;
}

export default async function StudioPage({ searchParams }: StudioPageProps) {
  const { draft } = await searchParams;
  const draftId = typeof draft === 'string' && isUuidV7(draft) ? draft : undefined;
  const returnTo = draftId ? `/studio?draft=${encodeURIComponent(draftId)}` : '/studio';
  const sessionState = await readAuthenticatedServerSessionState();
  if (sessionState.kind === 'needs-refresh') {
    redirect(`/auth/session/refresh?returnTo=${encodeURIComponent(returnTo)}`);
  }
  if (sessionState.kind !== 'active') {
    redirect('/login?returnTo=%2Fstudio');
  }
  const session = sessionState.session;
  const retryDraft = draftId ? readRetryDraft(draftId, { ownerId: session.ownerId }) : undefined;
  return (
    <StudioWorkspace
      gateway={clientStudioGateway}
      retryDraft={retryDraft}
      retryDraftRequested={typeof draft === 'string'}
    />
  );
}
