import { createHash } from 'node:crypto';
import { LedgerCommandSchema } from '@repo/contracts/wallet';
import { transition, type TaskStatus } from '../domain/task-state-machine.js';
import type { Clock, IdGenerator, LedgerCommand } from './ports.js';
import {
  ProviderEventsConsumerName,
  type OperatorCaseInput,
  type ConsumerResult,
  type ProviderEventRepository,
  type ProviderEventsConsumer,
  type SagaTask,
  type WalletEffectsPort,
} from './provider-events.consumer.js';

export type ProviderAcceptance = 'ACCEPTED' | 'UNACCEPTED' | 'UNKNOWN';
export type ProviderBilling = 'BILLED' | 'UNBILLED' | 'UNKNOWN';

export interface ProviderRuntimeInspection {
  readonly taskId: string;
  readonly providerId: string;
  readonly executionId: string;
  readonly providerTaskId: string;
  readonly routeEpoch: number;
  readonly state: 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'AMBIGUOUS';
  readonly acceptance: ProviderAcceptance;
  readonly billing: ProviderBilling;
  readonly resultUrls?: readonly string[];
  readonly errorCode?: string;
}

export interface ProviderRuntimeStatusPort {
  inspect(input: {
    readonly taskId: string;
    readonly providerId: string;
    readonly executionId: string;
    readonly providerTaskId: string;
    readonly routeEpoch: number;
  }): Promise<ProviderRuntimeInspection>;
}

interface RepairJobDependencies {
  readonly repository: ProviderEventRepository;
  readonly provider: ProviderRuntimeStatusPort;
  readonly providerEvents: Pick<ProviderEventsConsumer, 'consume'>;
  readonly wallet: WalletEffectsPort;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly batchSize?: number;
  readonly deadlinesMs?: Readonly<Partial<Record<TaskStatus, number>>>;
}

export interface RepairRunResult {
  readonly scanned: number;
  readonly repaired: number;
  readonly failedOver: number;
  readonly operatorRequired: number;
  readonly unchanged: number;
}

const defaultDeadlinesMs: Readonly<Partial<Record<TaskStatus, number>>> = {
  RESERVED: 60_000,
  QUEUED: 120_000,
  SUBMITTING: 120_000,
  RUNNING: 900_000,
  SUCCEEDED: 120_000,
  FAILED: 120_000,
  CANCELED: 120_000,
  EXPIRED: 120_000,
};

type RepairOutcome = 'repaired' | 'failedOver' | 'operatorRequired' | 'unchanged';

interface RepairMessage {
  readonly id: string;
  readonly payloadSha256: string;
  readonly traceId: string;
  readonly leaseToken: string;
}

class RepairLeaseFencedError extends Error {}

export class TaskRepairJob {
  private readonly batchSize: number;
  private readonly deadlinesMs: Readonly<Partial<Record<TaskStatus, number>>>;

  constructor(private readonly dependencies: RepairJobDependencies) {
    this.batchSize = dependencies.batchSize ?? 100;
    this.deadlinesMs = dependencies.deadlinesMs ?? defaultDeadlinesMs;
    if (!Number.isInteger(this.batchSize) || this.batchSize < 1 || this.batchSize > 1_000) {
      throw new Error('INVALID_REPAIR_BATCH_SIZE');
    }
    for (const deadline of Object.values(this.deadlinesMs)) {
      if (!Number.isInteger(deadline) || deadline < 1) {
        throw new Error('INVALID_REPAIR_DEADLINE');
      }
    }
  }

  async run(): Promise<RepairRunResult> {
    const scanNow = this.dependencies.clock.now();
    const tasks = await this.dependencies.repository.findStale({
      now: scanNow,
      deadlinesMs: this.deadlinesMs,
      limit: this.batchSize,
    });
    const result = {
      scanned: tasks.length,
      repaired: 0,
      failedOver: 0,
      operatorRequired: 0,
      unchanged: 0,
    };
    for (const task of tasks) {
      const outcome = await this.repair(task);
      result[outcome] += 1;
    }
    return result;
  }

  private async repair(task: SagaTask): Promise<RepairOutcome> {
    let message: RepairMessage | null = null;
    try {
      message = await this.claimRepair(task, this.dependencies.clock.now(), 'TASK_REPAIR');
      if (message === null) return 'unchanged';
      return await this.repairClaimed(task, message);
    } catch (error) {
      if (error instanceof RepairLeaseFencedError) return 'unchanged';
      if (message === null) return 'unchanged';
      try {
        const currentTask = (await this.dependencies.repository.getTask(task.taskId)) ?? task;
        await this.operatorCase(
          currentTask,
          message,
          'REPAIR_TASK_ERROR',
          'Repair failed in isolation and requires operator review.',
          { errorType: error instanceof Error ? error.name : 'UnknownError' },
        );
        return 'operatorRequired';
      } catch {
        return 'unchanged';
      }
    }
  }

  private async repairClaimed(task: SagaTask, message: RepairMessage): Promise<RepairOutcome> {
    const pendingFinancial = pendingFinancialPlan(task);
    const identity = providerIdentity(task);
    let inspection: ProviderRuntimeInspection | null = null;
    if (identity !== null) {
      await this.ensureRepairLease(message);
      inspection = await this.dependencies.provider.inspect(identity);
      if (!inspectionIdentityMatches(identity, inspection)) {
        await this.operatorCase(
          task,
          message,
          'PROVIDER_INSPECTION_IDENTITY_MISMATCH',
          'Provider Runtime inspection did not echo the immutable execution identity.',
          inspection,
        );
        return 'operatorRequired';
      }
      const expectedState = localExpectedProviderState(task);
      if (expectedState !== null && inspection.state !== expectedState) {
        await this.operatorCase(
          task,
          message,
          'LOCAL_TERMINAL_PROVIDER_STATE_CONTRADICTION',
          'Provider inspection contradicts durable local terminal or business-progress facts.',
          inspection,
        );
        return 'operatorRequired';
      }
    }
    if (pendingFinancial.kind === 'INVALID') {
      await this.operatorCase(
        task,
        message,
        'PENDING_FINANCIAL_DISPOSITION_INVALID',
        'The durable financial disposition is incomplete or inconsistent with task status.',
        {},
      );
      return 'operatorRequired';
    }
    if (pendingFinancial.kind === 'PENDING') {
      if (inspection !== null) {
        const financialContradiction =
          task.status === 'EXPIRED'
            ? !isSafeExpiredRelease(task, inspection)
            : inspection.state !== pendingFinancial.expectedProviderState;
        if (financialContradiction) {
          await this.operatorCase(
            task,
            message,
            'LOCAL_FINANCIAL_PROVIDER_STATE_CONTRADICTION',
            'Provider inspection contradicts the durable pending terminal financial disposition.',
            inspection,
          );
          return 'operatorRequired';
        }
      }
      return this.convergeFinancial(task, message, pendingFinancial);
    }
    if (identity === null) {
      const kind =
        task.providerTaskId === null ? 'PROVIDER_TASK_ID_MISSING' : 'PROVIDER_IDENTITY_MISSING';
      await this.operatorCase(
        task,
        message,
        kind,
        'A stale task has incomplete provider execution identity; acceptance and billing are unverifiable.',
        {},
      );
      return 'operatorRequired';
    }
    if (inspection === null) throw new Error('PROVIDER_INSPECTION_MISSING');
    if (inspection.acceptance === 'UNKNOWN' || inspection.billing === 'UNKNOWN') {
      await this.operatorCase(
        task,
        message,
        'PROVIDER_ACCEPTANCE_OR_BILLING_AMBIGUOUS',
        'Provider acceptance or billing could not be verified; automatic retry, refund and failover are blocked.',
        inspection,
      );
      return 'operatorRequired';
    }
    if (inspection.state === 'AMBIGUOUS') {
      await this.operatorCase(
        task,
        message,
        'PROVIDER_ACCEPTANCE_OR_BILLING_AMBIGUOUS',
        'Provider execution remains ambiguous and requires reconciliation.',
        inspection,
      );
      return 'operatorRequired';
    }
    if (
      (inspection.acceptance === 'UNACCEPTED' && task.providerAccepted) ||
      (inspection.acceptance === 'ACCEPTED' &&
        !task.providerAccepted &&
        task.providerStateRank > 0) ||
      (inspection.acceptance === 'UNACCEPTED' && inspection.billing === 'BILLED') ||
      (inspection.acceptance === 'UNACCEPTED' &&
        ['ACCEPTED', 'RUNNING', 'SUCCEEDED'].includes(inspection.state))
    ) {
      await this.operatorCase(
        task,
        message,
        'PROVIDER_FACT_CONTRADICTION',
        'Provider inspection contradicts the durable local acceptance facts.',
        inspection,
      );
      return 'operatorRequired';
    }
    if (task.status === 'EXPIRED') {
      if (task.providerAccepted || task.providerStateRank > 0) {
        await this.operatorCase(
          task,
          message,
          'EXPIRED_LOCAL_PROVIDER_FACT_CONTRADICTION',
          'Durable local acceptance or progress facts prohibit automatic expiry refund.',
          inspection,
        );
        return 'operatorRequired';
      }
      if (!isSafeExpiredRelease(task, inspection)) {
        await this.operatorCase(
          task,
          message,
          'EXPIRED_PROVIDER_FACT_CONTRADICTION',
          'Provider inspection is incompatible with safely refunding an expired generation task.',
          inspection,
        );
        return 'operatorRequired';
      }
      const plannedTask = await this.persistExpiredReleasePlan(task, message);
      const plan = pendingFinancialPlan(plannedTask);
      if (plan.kind !== 'PENDING') throw new Error('EXPIRED_RELEASE_PLAN_NOT_DURABLE');
      return this.convergeFinancial(plannedTask, message, plan);
    }
    if (inspection.acceptance === 'UNACCEPTED' && inspection.billing === 'UNBILLED') {
      if (!isSafeFailoverAuthorized(task)) {
        await this.operatorCase(
          task,
          message,
          'FAILOVER_NOT_SAFE',
          'The stored route does not satisfy every automatic failover invariant.',
          inspection,
        );
        return 'operatorRequired';
      }
      await this.scheduleFailover(task, message, inspection);
      return 'failedOver';
    }
    if (inspection.state === 'SUCCEEDED') {
      if (inspection.resultUrls === undefined || inspection.resultUrls.length === 0) {
        await this.operatorCase(
          task,
          message,
          'PROVIDER_SUCCESS_RESULT_MISSING',
          'Provider reports success without a durable result location.',
          inspection,
        );
        return 'operatorRequired';
      }
      if (task.providerId === null || task.modelCode === null) {
        await this.operatorCase(
          task,
          message,
          'PROVIDER_IDENTITY_MISSING',
          'A provider result cannot be bound to the stored routing identity.',
          inspection,
        );
        return 'operatorRequired';
      }
      await this.ensureRepairLease(message);
      const result = await this.dependencies.providerEvents.consume(
        this.providerEvent(task, this.dependencies.clock.now(), 'SUCCEEDED', inspection),
      );
      await this.completeRepairMessage(task, message);
      return classifyConsumeResult(result);
    }
    if (inspection.state === 'FAILED' || inspection.state === 'CANCELED') {
      if (task.providerId === null || task.modelCode === null) {
        await this.operatorCase(
          task,
          message,
          'PROVIDER_IDENTITY_MISSING',
          'A provider terminal state cannot be bound to the stored routing identity.',
          inspection,
        );
        return 'operatorRequired';
      }
      await this.ensureRepairLease(message);
      const result = await this.dependencies.providerEvents.consume(
        this.providerEvent(task, this.dependencies.clock.now(), inspection.state, inspection),
      );
      await this.completeRepairMessage(task, message);
      return classifyConsumeResult(result);
    }
    await this.ensureRepairLease(message);
    const result = await this.dependencies.providerEvents.consume(
      this.providerEvent(task, this.dependencies.clock.now(), inspection.state, inspection),
    );
    await this.completeRepairMessage(task, message);
    return classifyConsumeResult(result);
  }

  private providerEvent(
    task: SagaTask,
    now: Date,
    state: 'ACCEPTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED',
    inspection: ProviderRuntimeInspection,
  ) {
    if (
      task.providerId === null ||
      task.modelCode === null ||
      task.providerTaskId === null ||
      task.executionId === null
    ) {
      throw new Error('INVALID_REPAIR_PROVIDER_IDENTITY');
    }
    const id = this.dependencies.ids.next();
    return {
      id,
      type: `provider.execution-${state.toLowerCase()}.v1`,
      version: 1,
      occurredAt: now.toISOString(),
      traceId: createHash('sha256')
        .update(`repair:${task.taskId}:${id}`)
        .digest('hex')
        .slice(0, 32),
      correlationId: task.taskId,
      producer: 'provider-runtime',
      data: {
        executionId: task.executionId,
        taskId: task.taskId,
        providerId: task.providerId,
        modelCode: task.modelCode,
        providerTaskId: task.providerTaskId,
        attemptNumber: 1,
        routeEpoch: task.routeEpoch,
        status: state,
        ...(inspection.resultUrls === undefined ? {} : { resultUrls: inspection.resultUrls }),
        ...(inspection.errorCode === undefined ? {} : { errorCode: inspection.errorCode }),
      },
    };
  }

  private async scheduleFailover(
    task: SagaTask & {
      readonly substitute: NonNullable<SagaTask['substitute']>;
      readonly executionId: string;
      readonly providerId: string;
    },
    message: RepairMessage,
    inspection: ProviderRuntimeInspection,
  ): Promise<void> {
    const substitute = task.substitute;
    transition(task.status, 'QUEUED');
    const nextVersion = task.version + 1;
    const nextEpoch = task.routeEpoch + 1;
    await this.ensureRepairLease(message);
    const committedAt = this.dependencies.clock.now();
    const result = await this.dependencies.repository.write({
      messageId: message.id,
      payloadSha256: message.payloadSha256,
      taskId: task.taskId,
      expectedVersion: task.version,
      expectedSagaVersion: task.sagaVersion,
      leaseToken: message.leaseToken,
      patch: {
        status: 'QUEUED',
        providerAccepted: false,
        providerStateRank: 0,
        providerId: substitute.providerId,
        providerTaskId: null,
        modelCode: substitute.modelCode,
        executionId: null,
        routeEpoch: nextEpoch,
        settlementPoints: substitute.pricePoints,
      },
      transitions: [
        {
          id: this.dependencies.ids.next(),
          fromStatus: task.status,
          toStatus: 'QUEUED',
          taskVersion: nextVersion,
          reasonCode: 'SAFE_FAILOVER_REQUEUED',
          source: 'REPAIR',
          actorType: 'SERVICE',
          actorId: 'generation-service',
          traceId: message.traceId,
          metadata: { routeEpoch: nextEpoch, priorExecutionId: task.executionId },
          createdAt: committedAt,
        },
      ],
      occurredAt: committedAt,
      committedAt,
      completeMessage: true,
      operatorCase: {
        id: this.dependencies.ids.next(),
        kind: 'SAFE_FAILOVER_AUDIT',
        deduplicationKey: repairCaseKey(task, 'SAFE_FAILOVER_AUDIT'),
        summary:
          'Automatic failover was authorized only after unaccepted and unbilled confirmation.',
        status: 'RESOLVED',
        evidence: {
          originalProviderId: task.providerId,
          originalProviderTaskId: task.providerTaskId,
          substituteProviderId: substitute.providerId,
          substituteModelCode: substitute.modelCode,
          substitutePricePoints: substitute.pricePoints,
          acceptance: inspection.acceptance,
          billing: inspection.billing,
        },
      },
      outbox: {
        id: this.dependencies.ids.next(),
        eventType: 'generation.task-queued.v1',
        deduplicationKey: `task:${task.taskId}:failover:v${String(task.version)}`,
        payload: {
          taskId: task.taskId,
          userId: task.userId,
          quoteId: task.quoteId,
          capabilityVersionId: task.capabilityVersionId,
          status: 'QUEUED',
          taskVersion: nextVersion,
          quotedPoints: task.quotedPoints,
          parametersSnapshotSha256: task.parametersSnapshotSha256,
          routeEpoch: nextEpoch,
          failoverAuthorized: true,
          originalConfirmedUnaccepted: true,
          originalConfirmedUnbilled: true,
          priorExecutionId: task.executionId,
          authorizedProviderId: substitute.providerId,
          authorizedModelCode: substitute.modelCode,
        },
        headers: {
          traceId: message.traceId,
          correlationId: task.taskId,
          causationId: task.quoteId,
          producer: 'generation-service',
        },
        occurredAt: committedAt,
        availableAt: committedAt,
      },
    });
    if (result.kind === 'STALE') throw new RepairLeaseFencedError('TASK_REPAIR_FENCED');
  }

  private async convergeFinancial(
    task: SagaTask,
    message: RepairMessage,
    plan: PendingFinancialPlan,
  ): Promise<'repaired'> {
    for (const command of plan.commands) {
      await this.ensureRepairLease(message);
      if (command.kind === 'SETTLE') await this.dependencies.wallet.settle(command);
      else await this.dependencies.wallet.release(command);
    }
    transition(task.status, plan.targetStatus);
    const nextVersion = task.version + 1;
    await this.ensureRepairLease(message);
    const committedAt = this.dependencies.clock.now();
    const result = await this.dependencies.repository.write({
      messageId: message.id,
      payloadSha256: message.payloadSha256,
      taskId: task.taskId,
      expectedVersion: task.version,
      expectedSagaVersion: task.sagaVersion,
      leaseToken: message.leaseToken,
      patch: {
        status: plan.targetStatus,
        ...(plan.settlementPoints === undefined ? {} : { settlementPoints: plan.settlementPoints }),
      },
      transitions: [
        {
          id: this.dependencies.ids.next(),
          fromStatus: task.status,
          toStatus: plan.targetStatus,
          taskVersion: nextVersion,
          reasonCode: 'FINANCIAL_EFFECTS_REPAIRED',
          source: 'REPAIR',
          actorType: 'SERVICE',
          actorId: 'generation-service',
          traceId: message.traceId,
          metadata: { financialDisposition: task.financialDisposition },
          createdAt: committedAt,
        },
      ],
      occurredAt: committedAt,
      committedAt,
      completeMessage: true,
    });
    if (result.kind === 'STALE') throw new RepairLeaseFencedError('TASK_REPAIR_FENCED');
    return 'repaired';
  }

  private async persistExpiredReleasePlan(
    task: SagaTask,
    message: RepairMessage,
  ): Promise<SagaTask> {
    await this.ensureRepairLease(message);
    const committedAt = this.dependencies.clock.now();
    const result = await this.dependencies.repository.write({
      messageId: message.id,
      payloadSha256: message.payloadSha256,
      taskId: task.taskId,
      expectedVersion: task.version,
      expectedSagaVersion: task.sagaVersion,
      leaseToken: message.leaseToken,
      patch: {
        financialDisposition: 'EXPIRED_FULL_RELEASE',
        financialSettlementKey: null,
        financialReleaseKey: expiredReleaseKey(task.taskId),
      },
      transitions: [],
      occurredAt: committedAt,
      committedAt,
      completeMessage: false,
    });
    if (result.kind === 'STALE') throw new RepairLeaseFencedError('TASK_REPAIR_FENCED');
    return result.task;
  }

  private async operatorCase(
    task: SagaTask,
    message: RepairMessage,
    kind: string,
    summary: string,
    inspection: object,
  ): Promise<void> {
    const operatorCase: OperatorCaseInput = {
      id: this.dependencies.ids.next(),
      kind,
      summary,
      deduplicationKey: repairCaseKey(task, kind),
      evidence: {
        taskId: task.taskId,
        status: task.status,
        providerId: task.providerId,
        providerTaskId: task.providerTaskId,
        ...inspection,
      },
    };
    await this.ensureRepairLease(message);
    const committedAt = this.dependencies.clock.now();
    const result = await this.dependencies.repository.write({
      messageId: message.id,
      payloadSha256: message.payloadSha256,
      taskId: task.taskId,
      expectedVersion: task.version,
      expectedSagaVersion: task.sagaVersion,
      leaseToken: message.leaseToken,
      patch: {},
      transitions: [],
      occurredAt: committedAt,
      committedAt,
      completeMessage: true,
      operatorCase,
    });
    if (result.kind === 'STALE') throw new RepairLeaseFencedError('TASK_REPAIR_FENCED');
  }

  private async completeRepairMessage(task: SagaTask, message: RepairMessage): Promise<void> {
    const currentTask = await this.dependencies.repository.getTask(task.taskId);
    if (currentTask === null) throw new RepairLeaseFencedError('TASK_REPAIR_TASK_MISSING');
    await this.ensureRepairLease(message);
    const committedAt = this.dependencies.clock.now();
    const result = await this.dependencies.repository.write({
      messageId: message.id,
      payloadSha256: message.payloadSha256,
      taskId: currentTask.taskId,
      expectedVersion: currentTask.version,
      expectedSagaVersion: currentTask.sagaVersion,
      leaseToken: message.leaseToken,
      patch: {},
      transitions: [],
      occurredAt: committedAt,
      committedAt,
      completeMessage: true,
    });
    if (result.kind === 'STALE') throw new RepairLeaseFencedError('TASK_REPAIR_FENCED');
  }

  private async ensureRepairLease(message: RepairMessage): Promise<void> {
    const result = await this.dependencies.repository.renewLease({
      messageId: message.id,
      payloadSha256: message.payloadSha256,
      leaseToken: message.leaseToken,
      leaseDurationMs: 60_000,
    });
    if (result.kind === 'FENCED') throw new RepairLeaseFencedError('TASK_REPAIR_FENCED');
  }

  private async claimRepair(
    task: SagaTask,
    now: Date,
    reason: string,
  ): Promise<RepairMessage | null> {
    const id = this.dependencies.ids.next();
    const payloadSha256 = createHash('sha256')
      .update(`${task.taskId}:${String(task.version)}:${reason}`)
      .digest('hex');
    const traceId = createHash('sha256').update(`repair:${id}`).digest('hex').slice(0, 32);
    const ownerId = this.dependencies.ids.next();
    const leaseToken = createHash('sha256')
      .update(`${id}:${payloadSha256}:${ownerId}`)
      .digest('hex');
    const claim = await this.dependencies.repository.claim({
      consumer: ProviderEventsConsumerName,
      messageId: id,
      eventType: 'generation.task-repair.v1',
      payloadSha256,
      taskId: task.taskId,
      receivedAt: now,
      leaseToken,
      leaseExpiresAt: new Date(now.getTime() + 60_000),
    });
    if (claim.kind === 'DUPLICATE_COMPLETE' || claim.kind === 'DUPLICATE_PENDING') return null;
    if (claim.kind === 'TASK_NOT_FOUND' || claim.kind === 'PAYLOAD_CONFLICT') {
      throw new Error('TASK_REPAIR_CLAIM_FAILED');
    }
    return { id, payloadSha256, traceId, leaseToken };
  }
}

export function isSafeFailoverAuthorized(task: SagaTask): task is SagaTask & {
  readonly substitute: NonNullable<SagaTask['substitute']>;
  readonly executionId: string;
  readonly providerId: string;
} {
  const substitute = task.substitute;
  return (
    task.routingFailoverAuthorized &&
    task.status === 'SUBMITTING' &&
    !task.providerAccepted &&
    task.providerStateRank === 0 &&
    task.financialDisposition === null &&
    task.executionId !== null &&
    task.providerId !== null &&
    substitute !== null &&
    substitute.providerId !== task.providerId &&
    substitute.capabilityVersionId === task.capabilityVersionId &&
    points(substitute.pricePoints) <= points(task.quotedPoints)
  );
}

type ProviderIdentity = {
  readonly taskId: string;
  readonly providerId: string;
  readonly executionId: string;
  readonly providerTaskId: string;
  readonly routeEpoch: number;
};

type PendingFinancialPlan = {
  readonly kind: 'PENDING';
  readonly targetStatus: 'REFUNDED' | 'SETTLED';
  readonly expectedProviderState: 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  readonly settlementPoints?: string;
  readonly commands: readonly LedgerCommand[];
};

function providerIdentity(task: SagaTask): ProviderIdentity | null {
  return task.providerId === null || task.executionId === null || task.providerTaskId === null
    ? null
    : {
        taskId: task.taskId,
        providerId: task.providerId,
        executionId: task.executionId,
        providerTaskId: task.providerTaskId,
        routeEpoch: task.routeEpoch,
      };
}

function inspectionIdentityMatches(
  expected: ProviderIdentity,
  actual: ProviderRuntimeInspection,
): boolean {
  return (
    actual.taskId === expected.taskId &&
    actual.providerId === expected.providerId &&
    actual.executionId === expected.executionId &&
    actual.providerTaskId === expected.providerTaskId &&
    actual.routeEpoch === expected.routeEpoch
  );
}

function localExpectedProviderState(task: SagaTask): 'SUCCEEDED' | 'FAILED' | 'CANCELED' | null {
  if (task.status === 'SUCCEEDED' || task.assetImportRequested || task.assetId !== null) {
    return 'SUCCEEDED';
  }
  if (task.status === 'FAILED') return 'FAILED';
  if (task.status === 'CANCELED') return 'CANCELED';
  return null;
}

function isSafeExpiredRelease(task: SagaTask, inspection: ProviderRuntimeInspection): boolean {
  if (
    task.providerAccepted ||
    task.providerStateRank > 0 ||
    inspection.state === 'AMBIGUOUS' ||
    inspection.acceptance === 'UNKNOWN' ||
    inspection.billing !== 'UNBILLED'
  ) {
    return false;
  }
  return inspection.state === 'FAILED' || inspection.state === 'CANCELED';
}

function pendingFinancialPlan(
  task: SagaTask,
): PendingFinancialPlan | { readonly kind: 'NONE' | 'INVALID' } {
  try {
    if (task.status === 'EXPIRED') {
      if (task.financialDisposition === null) {
        return task.financialSettlementKey === null && task.financialReleaseKey === null
          ? { kind: 'NONE' }
          : { kind: 'INVALID' };
      }
      if (
        task.providerAccepted ||
        task.providerStateRank > 0 ||
        task.financialDisposition !== 'EXPIRED_FULL_RELEASE' ||
        task.financialSettlementKey !== null ||
        task.financialReleaseKey !== expiredReleaseKey(task.taskId)
      ) {
        return { kind: 'INVALID' };
      }
      return {
        kind: 'PENDING',
        targetStatus: 'REFUNDED',
        expectedProviderState: 'FAILED',
        commands: [
          ledger({
            businessKey: task.financialReleaseKey,
            userId: task.userId,
            kind: 'RELEASE',
            points: task.quotedPoints,
            reason: 'GENERATION_EXPIRED',
          }),
        ],
      };
    }
    if (task.status === 'SUCCEEDED') {
      if (task.financialDisposition === null) return { kind: 'NONE' };
      if (
        task.financialDisposition !== 'SUCCESS_SETTLEMENT' ||
        task.assetId === null ||
        task.financialSettlementKey === null ||
        task.financialReleaseKey === null
      ) {
        return { kind: 'INVALID' };
      }
      const quoted = points(task.quotedPoints);
      const settlement = points(task.settlementPoints);
      if (settlement > quoted) return { kind: 'INVALID' };
      const commands: LedgerCommand[] = [
        ledger({
          businessKey: task.financialSettlementKey,
          userId: task.userId,
          kind: 'SETTLE',
          points: settlement.toString(),
          reason: 'GENERATION_SUCCEEDED',
        }),
      ];
      const difference = quoted - settlement;
      if (difference > 0n) {
        commands.push(
          ledger({
            businessKey: task.financialReleaseKey,
            userId: task.userId,
            kind: 'RELEASE',
            points: difference.toString(),
            reason: 'QUOTE_DIFFERENCE',
          }),
        );
      }
      return {
        kind: 'PENDING',
        targetStatus: 'SETTLED',
        expectedProviderState: 'SUCCEEDED',
        settlementPoints: settlement.toString(),
        commands,
      };
    }
    if (task.status === 'FAILED') {
      if (task.financialDisposition === null) return { kind: 'NONE' };
      if (
        task.financialDisposition !== 'PROVIDER_FAILED_FULL_RELEASE' ||
        task.financialReleaseKey === null
      ) {
        return { kind: 'INVALID' };
      }
      return {
        kind: 'PENDING',
        targetStatus: 'REFUNDED',
        expectedProviderState: 'FAILED',
        commands: [
          ledger({
            businessKey: task.financialReleaseKey,
            userId: task.userId,
            kind: 'RELEASE',
            points: task.quotedPoints,
            reason: 'PROVIDER_FAILED',
          }),
        ],
      };
    }
    if (task.status !== 'CANCELED') return { kind: 'NONE' };
    if (task.financialDisposition === null) return { kind: 'NONE' };
    if (
      task.financialDisposition === 'PROVIDER_CANCELED_FULL_RELEASE' ||
      task.financialDisposition === 'PRE_ACCEPTANCE_FULL_RELEASE'
    ) {
      if (task.financialReleaseKey === null) return { kind: 'INVALID' };
      return {
        kind: 'PENDING',
        targetStatus: 'REFUNDED',
        expectedProviderState: 'CANCELED',
        commands: [
          ledger({
            businessKey: task.financialReleaseKey,
            userId: task.userId,
            kind: 'RELEASE',
            points: task.quotedPoints,
            reason:
              task.financialDisposition === 'PRE_ACCEPTANCE_FULL_RELEASE'
                ? 'CANCELED_BEFORE_PROVIDER_ACCEPTANCE'
                : 'PROVIDER_CANCELED',
          }),
        ],
      };
    }
    if (task.financialDisposition !== 'USER_CANCEL_RULE') return { kind: 'INVALID' };
    if (
      task.cancellationChargePoints === null ||
      task.financialReleaseKey === null ||
      task.financialSettlementKey === null
    ) {
      return { kind: 'INVALID' };
    }
    const quoted = points(task.quotedPoints);
    const charge = points(task.cancellationChargePoints);
    if (charge > quoted) return { kind: 'INVALID' };
    if (charge === 0n) {
      return {
        kind: 'PENDING',
        targetStatus: 'REFUNDED',
        expectedProviderState: 'CANCELED',
        commands: [
          ledger({
            businessKey: task.financialReleaseKey,
            userId: task.userId,
            kind: 'RELEASE',
            points: task.quotedPoints,
            reason: 'PROVIDER_CANCEL_CONFIRMED',
          }),
        ],
      };
    }
    const commands: LedgerCommand[] = [
      ledger({
        businessKey: task.financialSettlementKey,
        userId: task.userId,
        kind: 'SETTLE',
        points: charge.toString(),
        reason: 'PROVIDER_CANCEL_CONFIRMED',
      }),
    ];
    const difference = quoted - charge;
    if (difference > 0n) {
      commands.push(
        ledger({
          businessKey: task.financialReleaseKey,
          userId: task.userId,
          kind: 'RELEASE',
          points: difference.toString(),
          reason: 'QUOTE_DIFFERENCE',
        }),
      );
    }
    return {
      kind: 'PENDING',
      targetStatus: 'SETTLED',
      expectedProviderState: 'CANCELED',
      settlementPoints: charge.toString(),
      commands,
    };
  } catch {
    return { kind: 'INVALID' };
  }
}

function points(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('INVALID_POINTS');
  return BigInt(value);
}

function ledger(command: LedgerCommand): LedgerCommand {
  return LedgerCommandSchema.parse(command);
}

function classifyConsumeResult(
  result: ConsumerResult,
): 'repaired' | 'operatorRequired' | 'unchanged' {
  if (!result.ack) return 'unchanged';
  if (result.outcome === 'OPERATOR_REQUIRED') return 'operatorRequired';
  return ['PROGRESSED', 'ASSET_IMPORT_PENDING', 'SETTLED', 'REFUNDED'].includes(result.outcome)
    ? 'repaired'
    : 'unchanged';
}

function repairCaseKey(task: SagaTask, kind: string): string {
  return `generation-repair:${createHash('sha256')
    .update(`${task.taskId}:${task.providerTaskId ?? 'missing'}:${kind}`)
    .digest('hex')}`;
}

function expiredReleaseKey(taskId: string): string {
  return `task:${taskId}:expired-release`;
}
