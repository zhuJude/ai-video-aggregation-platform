'use client';

import { clientStudioGateway } from '../../lib/studio/client-gateway';
import type { RetryDraft } from '../../lib/tasks/types';
import { StudioWorkspace } from './studio-workspace';

interface StudioWorkspaceEntryProps {
  readonly retryDraft?: RetryDraft | undefined;
  readonly retryDraftRequested?: boolean | undefined;
}

export function StudioWorkspaceEntry(props: StudioWorkspaceEntryProps) {
  return <StudioWorkspace gateway={clientStudioGateway} {...props} />;
}
