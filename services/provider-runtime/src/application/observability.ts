export type ObservedProviderOperation = 'CREATE' | 'QUERY' | 'CANCEL' | 'CALLBACK';
export type ObservedProviderError =
  'RATE_LIMITED' | 'UNAVAILABLE' | 'TIMEOUT' | 'AUTH' | 'BALANCE' | 'PROTOCOL';

export interface ProviderRuntimeObserver {
  observeProviderCall(
    operation: ObservedProviderOperation,
    outcome: 'SUCCESS' | 'FAILURE',
    durationSeconds: number,
  ): void;
  recordProviderError(
    operation: ObservedProviderOperation,
    errorClass: ObservedProviderError,
  ): void;
  observeCircuitState(channelKey: string, state: 'CLOSED' | 'OPEN' | 'HALF_OPEN'): void;
}
