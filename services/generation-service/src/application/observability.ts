import type { TaskStatus } from '../domain/task-state-machine.js';

export interface GenerationDomainObserver {
  recordTaskState(status: TaskStatus): void;
  recordTransitionFailure(
    fromStatus: TaskStatus,
    toStatus: TaskStatus,
    reason: 'ILLEGAL_TRANSITION' | 'VERSION_CONFLICT' | 'PERSISTENCE_ERROR',
  ): void;
  observeQueueAge(seconds: number): void;
  setRepairCases(
    reason: 'AMBIGUOUS_PROVIDER_RESULT' | 'FINANCIAL_EFFECT_PENDING' | 'STALE_STATUS',
    value: number,
  ): void;
  incrementRepairCases(
    reason: 'AMBIGUOUS_PROVIDER_RESULT' | 'FINANCIAL_EFFECT_PENDING' | 'STALE_STATUS',
  ): void;
  refreshRepairCases(
    snapshot: Readonly<
      Record<'AMBIGUOUS_PROVIDER_RESULT' | 'FINANCIAL_EFFECT_PENDING' | 'STALE_STATUS', number>
    >,
  ): void;
  setFinancialSagaLag(phase: 'ASSET_IMPORT' | 'SETTLEMENT' | 'RELEASE', seconds: number): void;
  refreshFinancialSagaLag(
    snapshot: Readonly<Record<'ASSET_IMPORT' | 'SETTLEMENT' | 'RELEASE', number>>,
  ): void;
}
