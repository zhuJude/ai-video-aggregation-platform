export type ObservableProviderStatus = 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';

export type ProviderUpdateDecision =
  'APPLY' | 'OUT_OF_ORDER' | 'STATE_REGRESSION' | 'TERMINAL_IGNORED';

const terminalStatuses: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELED']);
const ranks: Readonly<Record<ObservableProviderStatus, number>> = {
  ACCEPTED: 1,
  RUNNING: 2,
  SUCCEEDED: 3,
  FAILED: 3,
  CANCELED: 3,
};

export function isTerminalProviderStatus(status: string): boolean {
  return terminalStatuses.has(status);
}

export function decideProviderUpdate(
  current: { readonly status: string; readonly lastSequence: number },
  next: ObservableProviderStatus,
  sequence: number,
): ProviderUpdateDecision {
  if (!Number.isSafeInteger(sequence) || sequence < 0) return 'OUT_OF_ORDER';
  if (sequence <= current.lastSequence) return 'OUT_OF_ORDER';
  if (isTerminalProviderStatus(current.status)) return 'TERMINAL_IGNORED';
  const currentRank =
    current.status in ranks ? ranks[current.status as ObservableProviderStatus] : 0;
  if (ranks[next] < currentRank) return 'STATE_REGRESSION';
  return 'APPLY';
}
