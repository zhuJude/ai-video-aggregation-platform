import { createHash, randomBytes } from 'node:crypto';
import { EventEnvelopeSchema, type EventEnvelope } from '@repo/contracts/common';
import { CreateTaskCommandSchema } from '@repo/contracts/generation';
import { QuoteSchema } from '@repo/contracts/routing';
import { LedgerCommandSchema } from '@repo/contracts/wallet';
import { canonicalJson, normalizeJson, StrictJsonError } from '../domain/canonical-json.js';
import { UuidV7Generator } from '../domain/uuid-v7.js';
import { GenerationApplicationError, type GenerationErrorCode } from './errors.js';
import type {
  Clock,
  IdGenerator,
  LedgerCommand,
  RoutingQuotePort,
  Sleep,
  WalletLedgerPort,
} from './ports.js';
import type { GenerationDomainObserver } from './observability.js';

export interface CreateTaskCommand {
  readonly userId: string;
  readonly quoteId: string;
  readonly capabilityVersionId: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly quotedPoints: string;
}

export interface CreateTaskPersistence {
  readonly taskId: string;
  readonly status: 'QUEUED';
  readonly version: 2;
}

export interface FailedIdempotencyResponse {
  readonly errorCode: string;
}

export type TaskCreationPhase =
  | 'CLAIMED'
  | 'RESERVE_REQUESTED'
  | 'RESERVED'
  | 'PERSISTENCE_FAILED'
  | 'COMPENSATION_REQUESTED'
  | 'COMPENSATED'
  | 'REPAIR_REQUIRED'
  | 'SUCCEEDED'
  | 'FAILED';

export interface IdempotencyClaim {
  readonly id: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly proposedTaskId: string;
  readonly quotedPoints: string;
  readonly reserveBusinessKey: string;
  readonly compensationBusinessKey: string;
  readonly traceId: string;
  readonly leaseToken: string;
  readonly phase: TaskCreationPhase;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export interface RepairRequiredInput {
  readonly repairCaseId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly leaseToken: string;
  readonly proposedTaskId: string;
  readonly quotedPoints: string;
  readonly reserveBusinessKey: string;
  readonly compensationBusinessKey: string;
  readonly traceId: string;
  readonly phase:
    | 'RESERVE_REQUESTED'
    | 'RESERVED'
    | 'PERSISTENCE_FAILED'
    | 'COMPENSATION_REQUESTED'
    | 'COMPENSATED';
  readonly errorCode:
    'WALLET_RESERVE_UNCERTAIN' | 'WALLET_COMPENSATION_UNCERTAIN' | 'TASK_CREATION_PHASE_STALLED';
  readonly detectedAt: Date;
}

export interface ReclaimIdempotencyInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly now: Date;
  readonly expiresAt: Date;
  readonly expectedLeaseToken: string;
  readonly newLeaseToken: string;
}

export interface BeginReservationInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly leaseToken: string;
  readonly expectedExpiresAt: Date;
  readonly now: Date;
}

export interface FinalizeIdempotencyFailureInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly leaseToken: string;
  readonly expectedPhase: TaskCreationPhase;
  readonly expectedExpiresAt: Date;
  readonly now: Date;
  readonly errorCode: string;
}

export interface AdvanceIdempotencyPhaseInput {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly leaseToken: string;
  readonly expectedPhase: TaskCreationPhase;
  readonly nextPhase: TaskCreationPhase;
}

export interface IdempotencyRecord extends IdempotencyClaim {
  readonly status: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';
  readonly taskId: string | null;
  readonly response: CreateTaskPersistence | FailedIdempotencyResponse | null;
}

export interface TaskTransitionInput {
  readonly id: string;
  readonly fromStatus: 'QUOTED' | 'RESERVED';
  readonly toStatus: 'RESERVED' | 'QUEUED';
  readonly taskVersion: 1 | 2;
  readonly reasonCode: 'POINTS_RESERVED' | 'TASK_CREATED';
  readonly source: 'API';
  readonly actorType: 'USER';
  readonly actorId: string;
  readonly traceId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface PersistTaskInput {
  readonly taskId: string;
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly leaseToken: string;
  readonly quoteId: string;
  readonly capabilityVersionId: string;
  readonly status: 'QUEUED';
  readonly version: 2;
  readonly quoteSnapshot: unknown;
  readonly quoteSnapshotSha256: string;
  readonly capabilitySnapshot: unknown;
  readonly capabilitySnapshotSha256: string;
  readonly pricingSnapshot: unknown;
  readonly pricingSnapshotSha256: string;
  readonly parametersSnapshot: Readonly<Record<string, unknown>>;
  readonly parametersSnapshotSha256: string;
  readonly transitions: readonly [TaskTransitionInput, TaskTransitionInput];
  readonly event: EventEnvelope;
  readonly createdAt: Date;
}

export interface TaskCreationRepository {
  claimIdempotency(claim: IdempotencyClaim): Promise<IdempotencyRecord>;
  tryReclaimIdempotency(input: ReclaimIdempotencyInput): Promise<boolean>;
  tryBeginReservation(input: BeginReservationInput): Promise<boolean>;
  getIdempotency(userId: string, idempotencyKey: string): Promise<IdempotencyRecord | null>;
  persistTask(input: PersistTaskInput): Promise<CreateTaskPersistence>;
  markIdempotencyFailed(input: FinalizeIdempotencyFailureInput): Promise<boolean>;
  updateIdempotencyPhase(input: AdvanceIdempotencyPhaseInput): Promise<boolean>;
  recordRepairRequired(input: RepairRequiredInput): Promise<boolean>;
}

interface CreateTaskDependencies {
  readonly repository: TaskCreationRepository;
  readonly routing: RoutingQuotePort;
  readonly wallet: WalletLedgerPort;
  readonly ids?: IdGenerator;
  readonly leaseTokens?: LeaseTokenSource;
  readonly clock?: Clock;
  readonly sleep?: Sleep;
  readonly maxPersistenceAttempts?: number;
  readonly contenderMaxAttempts?: number;
  readonly contenderBackoffMs?: number;
  readonly idempotencyTtlMs?: number;
  readonly observer?: GenerationDomainObserver;
}

interface ExecuteContext {
  readonly traceId?: string;
}

export interface LeaseTokenSource {
  next(): string;
}

const systemClock: Clock = { now: () => new Date() };
const systemSleep: Sleep = (milliseconds) =>
  new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
const systemLeaseTokens: LeaseTokenSource = {
  next: () => randomBytes(32).toString('hex'),
};

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function isPersistenceTransient(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('transient' in error && error.transient === true) return true;
  if (!('code' in error) || typeof error.code !== 'string') return false;
  return ['P2034', '40001', '40P01', 'CONNECTION_LOST', 'TIMEOUT'].includes(error.code);
}

function isSuccessResponse(
  response: IdempotencyRecord['response'],
): response is CreateTaskPersistence {
  return (
    typeof response === 'object' &&
    response !== null &&
    'taskId' in response &&
    typeof response.taskId === 'string'
  );
}

function failedCode(response: IdempotencyRecord['response']): string | undefined {
  if (typeof response !== 'object' || response === null || !('errorCode' in response)) {
    return undefined;
  }
  return typeof response.errorCode === 'string' ? response.errorCode : undefined;
}

function snapshotField(snapshot: unknown, field: string): unknown {
  return typeof snapshot === 'object' && snapshot !== null && field in snapshot
    ? (snapshot as Record<string, unknown>)[field]
    : undefined;
}

type PreReserveFailureCode = Extract<
  GenerationErrorCode,
  'ROUTING_UNAVAILABLE' | 'QUOTE_NOT_FOUND' | 'QUOTE_MISMATCH' | 'QUOTE_EXPIRED'
>;
type OwnerMutationOutcome = 'APPLIED' | 'STALE' | 'UNAVAILABLE';

export class CreateTaskService {
  private readonly repository: TaskCreationRepository;
  private readonly routing: RoutingQuotePort;
  private readonly wallet: WalletLedgerPort;
  private readonly ids: IdGenerator;
  private readonly leaseTokens: LeaseTokenSource;
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly maxPersistenceAttempts: number;
  private readonly contenderMaxAttempts: number;
  private readonly contenderBackoffMs: number;
  private readonly idempotencyTtlMs: number;
  private readonly observer: GenerationDomainObserver | undefined;

  constructor(dependencies: CreateTaskDependencies) {
    this.repository = dependencies.repository;
    this.routing = dependencies.routing;
    this.wallet = dependencies.wallet;
    this.ids = dependencies.ids ?? new UuidV7Generator();
    this.leaseTokens = dependencies.leaseTokens ?? systemLeaseTokens;
    this.clock = dependencies.clock ?? systemClock;
    this.sleep = dependencies.sleep ?? systemSleep;
    this.maxPersistenceAttempts = dependencies.maxPersistenceAttempts ?? 3;
    this.contenderMaxAttempts = dependencies.contenderMaxAttempts ?? 20;
    this.contenderBackoffMs = dependencies.contenderBackoffMs ?? 25;
    this.idempotencyTtlMs = dependencies.idempotencyTtlMs ?? 86_400_000;
    this.observer = dependencies.observer;
  }

  async execute(
    rawCommand: unknown,
    idempotencyKey: string,
    context: ExecuteContext = {},
  ): Promise<CreateTaskPersistence> {
    const command = this.parseCommand(rawCommand);
    this.validateIdempotencyKey(idempotencyKey);
    const requestSha256 = hash(command);
    const createdAt = this.clock.now();
    const proposedTaskId = this.ids.next();
    const operationTraceId = context.traceId ?? randomBytes(16).toString('hex');
    const claim: IdempotencyClaim = {
      id: this.ids.next(),
      userId: command.userId,
      idempotencyKey,
      requestSha256,
      proposedTaskId,
      quotedPoints: command.quotedPoints,
      reserveBusinessKey: `task:${proposedTaskId}:reserve`,
      compensationBusinessKey: `task:${proposedTaskId}:create-compensation`,
      traceId: operationTraceId,
      leaseToken: this.leaseTokens.next(),
      phase: 'CLAIMED',
      createdAt,
      expiresAt: new Date(createdAt.getTime() + this.idempotencyTtlMs),
    };
    const record = await this.repository.claimIdempotency(claim);

    if (record.requestSha256 !== requestSha256) {
      throw new GenerationApplicationError('IDEMPOTENCY_CONFLICT');
    }
    if (record.id !== claim.id) {
      if (
        record.status === 'IN_PROGRESS' &&
        record.phase === 'CLAIMED' &&
        record.expiresAt.getTime() <= createdAt.getTime()
      ) {
        let reclaimed: boolean;
        try {
          reclaimed = await this.repository.tryReclaimIdempotency({
            userId: command.userId,
            idempotencyKey,
            requestSha256,
            now: createdAt,
            expiresAt: claim.expiresAt,
            expectedLeaseToken: record.leaseToken,
            newLeaseToken: claim.leaseToken,
          });
        } catch {
          throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
        }
        if (reclaimed) {
          return this.executeWinner(command, idempotencyKey, requestSha256, {
            ...record,
            leaseToken: claim.leaseToken,
            expiresAt: claim.expiresAt,
          });
        }
      }
      return this.awaitWinner(record, command.userId, idempotencyKey);
    }

    return this.executeWinner(command, idempotencyKey, requestSha256, claim);
  }

  private parseCommand(rawCommand: unknown): CreateTaskCommand {
    let normalized;
    try {
      normalized = normalizeJson(rawCommand);
    } catch (error) {
      if (error instanceof StrictJsonError) {
        throw new GenerationApplicationError('INVALID_TASK_REQUEST');
      }
      throw error;
    }
    const parsed = CreateTaskCommandSchema.safeParse(normalized);
    if (!parsed.success) throw new GenerationApplicationError('INVALID_TASK_REQUEST');
    const normalizedParameters =
      typeof normalized === 'object' && normalized !== null && !Array.isArray(normalized)
        ? normalized.parameters
        : undefined;
    if (
      typeof normalizedParameters !== 'object' ||
      normalizedParameters === null ||
      Array.isArray(normalizedParameters)
    ) {
      throw new GenerationApplicationError('INVALID_TASK_REQUEST');
    }
    return { ...parsed.data, parameters: normalizedParameters };
  }

  private validateIdempotencyKey(key: string): void {
    if (key.length < 1 || key.length > 160 || key.trim() !== key) {
      throw new GenerationApplicationError('INVALID_IDEMPOTENCY_KEY');
    }
  }

  private async awaitWinner(
    initial: IdempotencyRecord,
    userId: string,
    idempotencyKey: string,
    staleOwner = false,
  ): Promise<CreateTaskPersistence> {
    let record: IdempotencyRecord | null = initial;
    for (let attempt = 0; attempt < this.contenderMaxAttempts; attempt += 1) {
      if (record.status === 'SUCCEEDED' && isSuccessResponse(record.response))
        return record.response;
      if (record.status === 'FAILED') {
        const code = failedCode(record.response);
        if (code === 'QUOTE_NOT_FOUND') throw new GenerationApplicationError('QUOTE_NOT_FOUND');
        if (code === 'ROUTING_UNAVAILABLE') {
          throw new GenerationApplicationError('ROUTING_UNAVAILABLE', true);
        }
        if (code === 'QUOTE_EXPIRED') throw new GenerationApplicationError('QUOTE_EXPIRED');
        if (code === 'QUOTE_MISMATCH') throw new GenerationApplicationError('QUOTE_MISMATCH');
        if (code === 'TASK_CREATION_REPAIR_REQUIRED') {
          throw new GenerationApplicationError('TASK_CREATION_REPAIR_REQUIRED');
        }
        if (code === 'REPAIR_PERSISTENCE_UNAVAILABLE') {
          throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
        }
        throw new GenerationApplicationError('TASK_CREATION_FAILED', true);
      }
      await this.sleep(this.contenderBackoffMs * (attempt + 1));
      record = await this.repository.getIdempotency(userId, idempotencyKey);
      if (record === null) break;
    }
    if (staleOwner) {
      throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
    }
    if (record !== null && this.isRepairablePhase(record.phase)) {
      return this.failWithRepair(
        record,
        record.phase,
        record.phase === 'RESERVE_REQUESTED'
          ? 'WALLET_RESERVE_UNCERTAIN'
          : record.phase === 'COMPENSATION_REQUESTED'
            ? 'WALLET_COMPENSATION_UNCERTAIN'
            : 'TASK_CREATION_PHASE_STALLED',
      );
    }
    if (record !== null && record.phase !== 'CLAIMED') {
      throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
    }
    throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
  }

  private isRepairablePhase(phase: TaskCreationPhase): phase is RepairRequiredInput['phase'] {
    return [
      'RESERVE_REQUESTED',
      'RESERVED',
      'PERSISTENCE_FAILED',
      'COMPENSATION_REQUESTED',
      'COMPENSATED',
    ].includes(phase);
  }

  private async executeWinner(
    command: CreateTaskCommand,
    idempotencyKey: string,
    requestSha256: string,
    operation: IdempotencyClaim,
  ): Promise<CreateTaskPersistence> {
    let route;
    try {
      route = await this.routing.getQuote(command.quoteId);
    } catch {
      return this.failWithoutReserve(operation, 'ROUTING_UNAVAILABLE', true);
    }
    if (route === null) {
      return this.failWithoutReserve(operation, 'QUOTE_NOT_FOUND');
    }

    let normalizedRoute;
    try {
      normalizedRoute = normalizeJson(route);
    } catch (error) {
      if (error instanceof StrictJsonError) {
        return this.failWithoutReserve(operation, 'QUOTE_MISMATCH');
      }
      throw error;
    }
    if (
      typeof normalizedRoute !== 'object' ||
      Array.isArray(normalizedRoute) ||
      normalizedRoute === null
    ) {
      return this.failWithoutReserve(operation, 'QUOTE_MISMATCH');
    }
    const quoteResult = QuoteSchema.safeParse(normalizedRoute.quote);
    if (!quoteResult.success) {
      return this.failWithoutReserve(operation, 'QUOTE_MISMATCH');
    }
    const quote = quoteResult.data;
    if (
      quote.id !== command.quoteId ||
      quote.userId !== command.userId ||
      quote.capabilityVersionId !== command.capabilityVersionId ||
      quote.quotedPoints !== command.quotedPoints ||
      quote.parametersHash !== hash(command.parameters) ||
      snapshotField(normalizedRoute.capabilitySnapshot, 'id') !== command.capabilityVersionId ||
      snapshotField(normalizedRoute.pricingSnapshot, 'quotedPoints') !== command.quotedPoints ||
      snapshotField(normalizedRoute.pricingSnapshot, 'pricingRuleVersion') !==
        quote.pricingRuleVersion
    ) {
      return this.failWithoutReserve(operation, 'QUOTE_MISMATCH');
    }
    if (Date.parse(quote.expiresAt) <= this.clock.now().getTime()) {
      return this.failWithoutReserve(operation, 'QUOTE_EXPIRED');
    }

    const taskId = operation.proposedTaskId;
    const reserve = LedgerCommandSchema.parse({
      businessKey: operation.reserveBusinessKey,
      userId: command.userId,
      kind: 'RESERVE',
      points: command.quotedPoints,
      reason: 'GENERATION_TASK_CREATE',
    });
    const release = LedgerCommandSchema.parse({
      businessKey: operation.compensationBusinessKey,
      userId: command.userId,
      kind: 'RELEASE',
      points: command.quotedPoints,
      reason: 'GENERATION_TASK_CREATE_COMPENSATION',
    });
    const traceId = operation.traceId;
    const now = this.clock.now();
    const quoteSnapshot = normalizeJson(quote);
    const capabilitySnapshot = normalizedRoute.capabilitySnapshot;
    const pricingSnapshot = normalizedRoute.pricingSnapshot;
    const parametersSnapshot = normalizeJson(command.parameters);
    if (
      typeof parametersSnapshot !== 'object' ||
      Array.isArray(parametersSnapshot) ||
      parametersSnapshot === null
    ) {
      return this.failWithoutReserve(operation, 'QUOTE_MISMATCH');
    }
    const reservedTransitionId = this.ids.next();
    const queuedTransitionId = this.ids.next();
    const event = EventEnvelopeSchema.parse({
      id: this.ids.next(),
      type: 'generation.task-queued.v1',
      version: 1,
      occurredAt: now.toISOString(),
      traceId,
      correlationId: taskId,
      causationId: command.quoteId,
      producer: 'generation-service',
      data: {
        taskId,
        userId: command.userId,
        quoteId: command.quoteId,
        capabilityVersionId: command.capabilityVersionId,
        status: 'QUEUED',
        taskVersion: 2,
        quotedPoints: command.quotedPoints,
        parametersSnapshotSha256: hash(parametersSnapshot),
      },
    });
    const transitionBase = {
      source: 'API' as const,
      actorType: 'USER' as const,
      actorId: command.userId,
      traceId,
      metadata: { quoteId: command.quoteId },
      createdAt: now,
    };
    const input: PersistTaskInput = {
      taskId,
      userId: command.userId,
      idempotencyKey,
      requestSha256,
      leaseToken: operation.leaseToken,
      quoteId: command.quoteId,
      capabilityVersionId: command.capabilityVersionId,
      status: 'QUEUED',
      version: 2,
      quoteSnapshot,
      quoteSnapshotSha256: hash(quoteSnapshot),
      capabilitySnapshot,
      capabilitySnapshotSha256: hash(capabilitySnapshot),
      pricingSnapshot,
      pricingSnapshotSha256: hash(pricingSnapshot),
      parametersSnapshot,
      parametersSnapshotSha256: hash(parametersSnapshot),
      transitions: [
        {
          ...transitionBase,
          id: reservedTransitionId,
          fromStatus: 'QUOTED',
          toStatus: 'RESERVED',
          taskVersion: 1,
          reasonCode: 'POINTS_RESERVED',
        },
        {
          ...transitionBase,
          id: queuedTransitionId,
          fromStatus: 'RESERVED',
          toStatus: 'QUEUED',
          taskVersion: 2,
          reasonCode: 'TASK_CREATED',
        },
      ],
      event,
      createdAt: now,
    };
    if (!(await this.beginReservation(operation))) {
      let current: IdempotencyRecord | null;
      try {
        current = await this.repository.getIdempotency(command.userId, idempotencyKey);
      } catch {
        throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
      }
      const phaseCommittedByLeaseHolder =
        current?.status === 'IN_PROGRESS' &&
        current.phase === 'RESERVE_REQUESTED' &&
        current.requestSha256 === requestSha256 &&
        current.leaseToken === operation.leaseToken &&
        current.expiresAt.getTime() === operation.expiresAt.getTime();
      if (!phaseCommittedByLeaseHolder && current !== null) {
        return this.awaitWinner(current, command.userId, idempotencyKey, true);
      }
      if (!phaseCommittedByLeaseHolder) {
        throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
      }
    }
    try {
      await this.wallet.reserve(reserve);
    } catch {
      return this.failWithRepair(operation, 'RESERVE_REQUESTED', 'WALLET_RESERVE_UNCERTAIN');
    }

    const reserved = await this.advancePhase(operation, 'RESERVE_REQUESTED', 'RESERVED');
    if (reserved === 'STALE') {
      return this.consumeCurrent(operation);
    }
    if (reserved === 'UNAVAILABLE') {
      return this.compensateAndFail(operation, release, 'RESERVE_REQUESTED');
    }

    try {
      return await this.persistWithRetry(input);
    } catch {
      let finalRecord: IdempotencyRecord | null;
      try {
        finalRecord = await this.repository.getIdempotency(command.userId, idempotencyKey);
      } catch {
        throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
      }
      if (
        finalRecord?.requestSha256 === requestSha256 &&
        finalRecord.status === 'SUCCEEDED' &&
        isSuccessResponse(finalRecord.response)
      ) {
        return finalRecord.response;
      }
      if (finalRecord === null || finalRecord.status !== 'IN_PROGRESS') {
        throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
      }
      const persistenceFailed = await this.advancePhase(
        operation,
        'RESERVED',
        'PERSISTENCE_FAILED',
      );
      if (persistenceFailed === 'STALE') {
        return this.consumeCurrent(operation);
      }
      return this.compensateAndFail(
        operation,
        release,
        persistenceFailed === 'APPLIED' ? 'PERSISTENCE_FAILED' : 'RESERVED',
      );
    }
  }

  private async persistWithRetry(input: PersistTaskInput): Promise<CreateTaskPersistence> {
    for (let attempt = 1; attempt <= this.maxPersistenceAttempts; attempt += 1) {
      try {
        const persisted = await this.repository.persistTask(input);
        this.observer?.recordTaskState('RESERVED');
        this.observer?.recordTaskState('QUEUED');
        return persisted;
      } catch (error) {
        if (!isPersistenceTransient(error) || attempt === this.maxPersistenceAttempts) throw error;
        await this.sleep(this.contenderBackoffMs * attempt);
      }
    }
    throw new Error('UNREACHABLE_PERSISTENCE_RETRY');
  }

  private async compensateAndFail(
    operation: IdempotencyClaim,
    release: LedgerCommand,
    expectedPhase: 'RESERVE_REQUESTED' | 'RESERVED' | 'PERSISTENCE_FAILED',
  ): Promise<CreateTaskPersistence> {
    const compensationRequested = await this.advancePhase(
      operation,
      expectedPhase,
      'COMPENSATION_REQUESTED',
    );
    if (compensationRequested === 'STALE') {
      return this.consumeCurrent(operation);
    }
    if (compensationRequested === 'UNAVAILABLE') {
      throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
    }
    try {
      await this.wallet.release(release);
    } catch {
      return this.failWithRepair(
        operation,
        'COMPENSATION_REQUESTED',
        'WALLET_COMPENSATION_UNCERTAIN',
      );
    }

    const compensated = await this.advancePhase(operation, 'COMPENSATION_REQUESTED', 'COMPENSATED');
    if (compensated === 'STALE') {
      return this.consumeCurrent(operation);
    }
    if (compensated === 'UNAVAILABLE') {
      throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
    }

    if (!(await this.persistFailureStatus(operation, 'COMPENSATED', 'TASK_CREATION_FAILED'))) {
      let current: IdempotencyRecord | null;
      try {
        current = await this.repository.getIdempotency(operation.userId, operation.idempotencyKey);
      } catch {
        throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
      }
      if (
        current?.leaseToken === operation.leaseToken &&
        current.status === 'FAILED' &&
        failedCode(current.response) === 'TASK_CREATION_FAILED'
      ) {
        throw new GenerationApplicationError('TASK_CREATION_FAILED', true);
      }
      if (current !== null && current.leaseToken !== operation.leaseToken) {
        return this.awaitWinner(current, operation.userId, operation.idempotencyKey, true);
      }
      throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
    }
    throw new GenerationApplicationError('TASK_CREATION_FAILED', true);
  }

  private async failWithoutReserve(
    operation: IdempotencyClaim,
    errorCode: PreReserveFailureCode,
    retryable = false,
  ): Promise<CreateTaskPersistence> {
    if (await this.persistFailureStatus(operation, 'CLAIMED', errorCode)) {
      throw new GenerationApplicationError(errorCode, retryable);
    }
    let current: IdempotencyRecord | null;
    try {
      current = await this.repository.getIdempotency(operation.userId, operation.idempotencyKey);
    } catch {
      throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
    }
    if (current === null) {
      throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
    }
    if (current.leaseToken !== operation.leaseToken) {
      return this.awaitWinner(current, operation.userId, operation.idempotencyKey, true);
    }
    if (current.status === 'FAILED' && failedCode(current.response) === errorCode) {
      throw new GenerationApplicationError(errorCode, retryable);
    }
    throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
  }

  private async persistFailureStatus(
    operation: IdempotencyClaim,
    expectedPhase: TaskCreationPhase,
    errorCode: string,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= this.maxPersistenceAttempts; attempt += 1) {
      try {
        if (
          await this.repository.markIdempotencyFailed({
            userId: operation.userId,
            idempotencyKey: operation.idempotencyKey,
            requestSha256: operation.requestSha256,
            leaseToken: operation.leaseToken,
            expectedPhase,
            expectedExpiresAt: operation.expiresAt,
            now: this.clock.now(),
            errorCode,
          })
        ) {
          return true;
        }
        return false;
      } catch {
        if (attempt < this.maxPersistenceAttempts) {
          await this.sleep(this.contenderBackoffMs * attempt);
        }
      }
    }
    return false;
  }

  private async advancePhase(
    operation: IdempotencyClaim,
    expectedPhase: TaskCreationPhase,
    nextPhase: TaskCreationPhase,
  ): Promise<OwnerMutationOutcome> {
    for (let attempt = 1; attempt <= this.maxPersistenceAttempts; attempt += 1) {
      try {
        if (
          await this.repository.updateIdempotencyPhase({
            userId: operation.userId,
            idempotencyKey: operation.idempotencyKey,
            requestSha256: operation.requestSha256,
            leaseToken: operation.leaseToken,
            expectedPhase,
            nextPhase,
          })
        ) {
          return 'APPLIED';
        }
        break;
      } catch {
        if (attempt < this.maxPersistenceAttempts) {
          await this.sleep(this.contenderBackoffMs * attempt);
        }
      }
    }
    let current: IdempotencyRecord | null;
    try {
      current = await this.repository.getIdempotency(operation.userId, operation.idempotencyKey);
    } catch {
      return 'UNAVAILABLE';
    }
    if (
      current?.leaseToken === operation.leaseToken &&
      current.status === 'IN_PROGRESS' &&
      current.phase === nextPhase
    ) {
      return 'APPLIED';
    }
    if (current !== null && current.leaseToken !== operation.leaseToken) {
      return 'STALE';
    }
    if (current !== null && current.status !== 'IN_PROGRESS') {
      return 'STALE';
    }
    return 'UNAVAILABLE';
  }

  private async consumeCurrent(operation: IdempotencyClaim): Promise<CreateTaskPersistence> {
    let current: IdempotencyRecord | null;
    try {
      current = await this.repository.getIdempotency(operation.userId, operation.idempotencyKey);
    } catch {
      throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
    }
    if (current === null) throw new GenerationApplicationError('IDEMPOTENCY_IN_PROGRESS', true);
    return this.awaitWinner(current, operation.userId, operation.idempotencyKey, true);
  }

  private async beginReservation(operation: IdempotencyClaim): Promise<boolean> {
    for (let attempt = 1; attempt <= this.maxPersistenceAttempts; attempt += 1) {
      try {
        return await this.repository.tryBeginReservation({
          userId: operation.userId,
          idempotencyKey: operation.idempotencyKey,
          requestSha256: operation.requestSha256,
          leaseToken: operation.leaseToken,
          expectedExpiresAt: operation.expiresAt,
          now: this.clock.now(),
        });
      } catch {
        if (attempt < this.maxPersistenceAttempts) {
          await this.sleep(this.contenderBackoffMs * attempt);
        }
      }
    }
    return false;
  }

  private async failWithRepair(
    operation: IdempotencyClaim,
    phase: RepairRequiredInput['phase'],
    errorCode: RepairRequiredInput['errorCode'],
  ): Promise<CreateTaskPersistence> {
    const repair: RepairRequiredInput = {
      repairCaseId: this.ids.next(),
      userId: operation.userId,
      idempotencyKey: operation.idempotencyKey,
      requestSha256: operation.requestSha256,
      leaseToken: operation.leaseToken,
      proposedTaskId: operation.proposedTaskId,
      quotedPoints: operation.quotedPoints,
      reserveBusinessKey: operation.reserveBusinessKey,
      compensationBusinessKey: operation.compensationBusinessKey,
      traceId: operation.traceId,
      phase,
      errorCode,
      detectedAt: this.clock.now(),
    };
    for (let attempt = 1; attempt <= this.maxPersistenceAttempts; attempt += 1) {
      try {
        if (await this.repository.recordRepairRequired(repair)) {
          throw new GenerationApplicationError('TASK_CREATION_REPAIR_REQUIRED');
        }
        break;
      } catch (error) {
        if (error instanceof GenerationApplicationError) throw error;
        if (attempt < this.maxPersistenceAttempts) {
          await this.sleep(this.contenderBackoffMs * attempt);
        }
      }
    }
    let current: IdempotencyRecord | null;
    try {
      current = await this.repository.getIdempotency(operation.userId, operation.idempotencyKey);
    } catch {
      throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
    }
    if (current !== null && current.leaseToken !== operation.leaseToken) {
      return this.awaitWinner(current, operation.userId, operation.idempotencyKey, true);
    }
    if (
      current?.status === 'FAILED' &&
      failedCode(current.response) === 'TASK_CREATION_REPAIR_REQUIRED'
    ) {
      throw new GenerationApplicationError('TASK_CREATION_REPAIR_REQUIRED');
    }
    throw new GenerationApplicationError('REPAIR_PERSISTENCE_UNAVAILABLE', true);
  }
}
