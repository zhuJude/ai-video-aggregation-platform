import { StudioWorkspace } from '../../components/studio/studio-workspace';
import { readRetryDraft } from '../../lib/studio/retry-drafts';

interface StudioPageProps {
  readonly searchParams: Promise<{ readonly draft?: string | string[] }>;
}

export default async function StudioPage({ searchParams }: StudioPageProps) {
  const { draft } = await searchParams;
  const draftId = typeof draft === 'string' ? draft : undefined;
  const retryDraft = draftId ? readRetryDraft(draftId) : undefined;
  return <StudioWorkspace retryDraft={retryDraft} retryDraftRequested={draftId !== undefined} />;
}
