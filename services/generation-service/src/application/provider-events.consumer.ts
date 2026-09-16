import { createHash } from 'node:crypto';
import { EventEnvelopeSchema, UuidSchema } from '@repo/contracts/common';
import { LedgerCommandSchema } from '@repo/contracts/wallet';
import { z } from 'zod';
import { canonicalJson, StrictJsonError } from '../domain/canonical-json.js';
import { transition, type TaskStatus } from '../domain/task-state-machine.js';
import type { Clock, IdGenerator, LedgerCommand } from './ports.js';
import type { GenerationDomainObserver } from './observability.js';

export const ProviderEventsConsumerName = 'generation-service:provider-events:v1' as const;

const ProviderEventTypeSchema = z.enum([
  'provider.execution-accepted.v1',
  'provider.execution-running.v1',
  'provider.execution-succeeded.v1',
  'provider.execution-failed.v1',
  'provider.execution-canceled.v1',
  'provider.execution-ambiguous.v1',
]);
const ProviderDataSchema = z.strictObject({
  executionId: UuidSchema,
  taskId: UuidSchema,
  capabilityVersionId: UuidSchema.optional(),
  parametersSnapshotSha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  providerId: UuidSchema,
  modelCode: z.string().min(1).max(160).optional(),
  providerTaskId: z.string().min(1).max(512).optional(),
  providerEventId: z.string().min(1).max(256).optional(),
  sequence: z.int().nonnegative().optional(),
  attemptNumber: z.int().positive(),
  pollNumber: z.int().positive().optional(),
  routeEpoch: z.int().nonnegative().default(0),
  status: z.enum(['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'AMBIGUOUS']),
  resultUrls: z.array(z.url()).max(32).optional(),
  errorCode: z.string().min(1).max(120).optional(),
  nextAction: z.enum(['NONE', 'CREATE_RETRY', 'RECONCILE', 'POLL']).optional(),
  immediateSuccessRequiresQuery: z.boolean().optional(),
  repairRequired: z.boolean().optional(),
});
const AssetImportedDataSchema = z.strictObject({
  taskId: UuidSchema,
  assetId: UuidSchema,
  importBusinessKey: z.string().min(8).max(120),
});
const CancelRequestedDataSchema = z.strictObject({
  taskId: UuidSchema,
  userId: UuidSchema,
  currentStatus: z.string().min(1),
  currentVersion: z.int().nonnegative(),
});

export interface FailoverCandidate {
  readonly providerId: string;
  readonly modelCode: string;
  readonly capabilityVersionId: string;
  readonly pricePoints: string;
}

export interface SagaTask {
  readonly taskId: string;
  readonly userId: string;
  readonly quoteId: string;
  readonly status: TaskStatus;
  readonly version: number;
  readonly sagaVersion: number;
  readonly quotedPoints: string;
  readonly settlementPoints: string;
  readonly capabilityVersionId: string;
  readonly parametersSnapshotSha256: string;
  readonly providerAccepted: boolean;
  readonly providerStateRank: number;
  readonly providerId: string | null;
  readonly providerTaskId: string | null;
  readonly modelCode: string | null;
  readonly executionId: string | null;
  readonly routeEpoch: number;
  readonly assetImportRequested: boolean;
  readonly assetImportDispatched: boolean;
  readonly assetId: string | null;
  readonly routingFailoverAuthorized: boolean;
  readonly cancellationChargePoints: string | null;
  readonly cancelRequested: boolean;
  readonly financialDisposition:
    | 'SUCCESS_SETTLEMENT'
    | 'PROVIDER_FAILED_FULL_RELEASE'
    | 'PROVIDER_CANCELED_FULL_RELEASE'
    | 'PRE_ACCEPTANCE_FULL_RELEASE'
    | 'EXPIRED_FULL_RELEASE'
    | 'USER_CANCEL_RULE'
    | null;
  readonly financialSettlementKey: string | null;
  readonly financialReleaseKey: string | null;
  readonly substitute: FailoverCandidate | null;
  readonly updatedAt: Date;
}

export interface SagaTransition {
  readonly id: string;
  readonly fromStatus: TaskStatus;
  readonly toStatus: TaskStatus;
  readonly taskVersion: number;
  readonly reasonCode: string;
  readonly source: 'WORKER' | 'REPAIR';
  readonly actorType: 'SERVICE' | 'PROVIDER';
  readonly actorId: string;
  readonly traceId: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
}

export interface OperatorCaseInput {
  readonly id: string;
  readonly kind: string;
  readonly summary: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly status?: 'OPEN' | 'RESOLVED';
  readonly deduplicationKey?: string;
}

export interface SagaOutboxInput {
  readonly id: string;
  readonly eventType: string;
  readonly deduplicationKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly headers: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
  readonly availableAt: Date;
}

export interface SagaWrite {
  readonly messageId: string;
  readonly payloadSha256: string;
  readonly taskId: string;
  readonly expectedVersion: number;
  readonly expectedSagaVersion: number;
  readonly leaseToken: string;
  readonly patch: Partial<Omit<SagaTask, 'taskId' | 'userId' | 'version' | 'updatedAt'>>;
  readonly transitions: readonly SagaTransition[];
  readonly occurredAt: Date;
  readonly committedAt: Date;
  readonly completeMessage: boolean;
  readonly operatorCase?: OperatorCaseInput;
  readonly outbox?: SagaOutboxInput;
}

export interface ClaimMessageInput {
  readonly consumer: typeof ProviderEventsConsumerName;
  readonly messageId: string;
  readonly eventType: string;
  readonly payloadSha256: string;
  readonly taskId: string;
  readonly receivedAt: Date;
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export type ClaimMessageResult =
  | { readonly kind: 'CLAIMED'; readonly task: SagaTask }
  | { readonly kind: 'DUPLICATE_PENDING'; readonly task: SagaTask }
  | { readonly kind: 'DUPLICATE_COMPLETE' }
  | { readonly kind: 'TASK_NOT_FOUND' }
  | { readonly kind: 'PAYLOAD_CONFLICT' };

export interface StaleTaskQuery {
  readonly now: Date;
  readonly deadlinesMs: Readonly<Partial<Record<TaskStatus, number>>>;
  readonly limit: number;
}

export interface ProviderEventRepository {
  claim(input: ClaimMessageInput): Promise<ClaimMessageResult>;
  renewLease(input: {
    readonly messageId: string;
    readonly payloadSha256: string;
    readonly leaseToken: string;
    readonly leaseDurationMs: number;
  }): Promise<{ readonly kind: 'RENEWED' } | { readonly kind: 'FENCED' }>;
  write(
    input: SagaWrite,
  ): Promise<{ readonly kind: 'APPLIED'; readonly task: SagaTask } | { readonly kind: 'STALE' }>;
  getTask(taskId: string): Promise<SagaTask | null>;
  findStale(query: StaleTaskQuery): Promise<readonly SagaTask[]>;
  repairMetricsSnapshot?(input: {
    readonly now: Date;
    readonly deadlinesMs: Readonly<Partial<Record<TaskStatus, number>>>;
  }): Promise<{
    readonly repairCases: Readonly<
      Record<'AMBIGUOUS_PROVIDER_RESULT' | 'FINANCIAL_EFFECT_PENDING' | 'STALE_STATUS', number>
    >;
    readonly financialSagaLag: Readonly<Record<'ASSET_IMPORT' | 'SETTLEMENT' | 'RELEASE', number>>;
  }>;
}

export interface AssetImportPort {
  requestImport(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly resultUrls: readonly string[];
    readonly businessKey: string;
    readonly traceId: string;
  }): Promise<void>;
}

export interface WalletEffectsPort {
  settle(command: LedgerCommand): Promise<void>;
  release(command: LedgerCommand): Promise<void>;
}

export interface CancellationPort {
  cancel(input: {
    readonly taskId: string;
    readonly providerTaskId: string;
    readonly businessKey: string;
    readonly traceId: string;
  }): Promise<{ readonly outcome: 'CONFIRMED' | 'REJECTED' | 'AMBIGUOUS' }>;
}

interface ProviderEventsDependencies {
  readonly repository: ProviderEventRepository;
  readonly asset: AssetImportPort;
  readonly wallet: WalletEffectsPort;
  readonly cancellation: CancellationPort | null;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly leaseDurationMs?: number;
  readonly observer?: GenerationDomainObserver;
}

export interface ConsumerResult {
  readonly ack: boolean;
  readonly outcome:
    | 'ASSET_IMPORT_PENDING'
    | 'SETTLED'
    | 'REFUNDED'
    | 'PROGRESSED'
    | 'STALE_PROVIDER_EVENT'
    | 'OPERATOR_REQUIRED'
    | 'DUPLICATE_COMPLETE'
    | 'DUPLICATE_PENDING'
    | 'STALE_CANCEL_COMMAND'
    | 'RETRY';
}

interface ParsedMessage {
  readonly id: string;
  readonly type: string;
  readonly taskId: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
  readonly data: Record<string, unknown>;
  readonly payloadSha256: string;
}

interface ActiveMessage extends ParsedMessage {
  readonly leaseToken: string;
  readonly leaseExpiresAt: Date;
}

export class ProviderEventsConsumer {
  private readonly leaseDurationMs: number;

  constructor(private readonly dependencies: ProviderEventsDependencies) {
    this.leaseDurationMs = dependencies.leaseDurationMs ?? 60_000;
    if (!Number.isInteger(this.leaseDurationMs) || this.leaseDurationMs < 1) {
      throw new Error('INVALID_INBOX_LEASE_DURATION');
    }
  }

  async consume(rawEvent: unknown): Promise<ConsumerResult> {
    const message = this.parse(rawEvent);
    const { claim, leaseToken, leaseExpiresAt } = await this.claim(message);
    if (claim.kind === 'DUPLICATE_COMPLETE') {
      return { ack: true, outcome: 'DUPLICATE_COMPLETE' };
    }
    if (claim.kind === 'DUPLICATE_PENDING') {
      return { ack: false, outcome: 'DUPLICATE_PENDING' };
    }
    if (claim.kind === 'TASK_NOT_FOUND' || claim.kind === 'PAYLOAD_CONFLICT') {
      return { ack: false, outcome: 'RETRY' };
    }
    const active: ActiveMessage = { ...message, leaseToken, leaseExpiresAt };
    const task = claim.task;
    if (message.type === 'generation.task-cancel-requested.v1') {
      return this.onCancel(active, task);
    }
    if (message.type === 'asset.imported.v1') {
      return this.onAssetImported(active, task);
    }
    if (!this.providerBindingMatches(active, task)) {
      return this.operatorRequired(
        active,
        task,
        'STALE_PROVIDER_EXECUTION_EVENT',
        'Provider event does not match the current immutable route epoch and execution binding.',
      );
    }
    if (message.type === 'provider.execution-ambiguous.v1') {
      return this.onAmbiguous(active, task);
    }
    if (message.type === 'provider.execution-succeeded.v1') {
      return this.onSucceeded(active, task);
    }
    if (message.type === 'provider.execution-failed.v1') {
      return this.onFailed(active, task, 'PROVIDER_FAILED');
    }
    if (message.type === 'provider.execution-canceled.v1') {
      return this.onFailed(active, task, 'PROVIDER_CANCELED');
    }
    const providerState = String(message.data.status);
    const rank = providerEventStateRank(providerState);
    if (rank < task.providerStateRank || (rank === task.providerStateRank && rank > 0)) {
      await this.completeNoop(active, task);
      return { ack: true, outcome: 'STALE_PROVIDER_EVENT' };
    }
    return this.onProgress(active, task, rank);
  }

  async cancel(input: {
    readonly messageId: string;
    readonly taskId: string;
    readonly traceId: string;
    readonly userId: string;
    readonly currentStatus: SagaTask['status'];
    readonly currentVersion: number;
  }): Promise<ConsumerResult> {
    const occurredAt = this.dependencies.clock.now();
    const message: ParsedMessage = {
      id: input.messageId,
      type: 'generation.task-cancel-requested.v1',
      taskId: input.taskId,
      traceId: input.traceId,
      correlationId: input.taskId,
      occurredAt,
      data: {
        taskId: input.taskId,
        userId: input.userId,
        currentStatus: input.currentStatus,
        currentVersion: input.currentVersion,
      },
      payloadSha256: sha256(input),
    };
    const { claim, leaseToken, leaseExpiresAt } = await this.claim(message);
    if (claim.kind === 'DUPLICATE_COMPLETE') {
      return { ack: true, outcome: 'DUPLICATE_COMPLETE' };
    }
    if (claim.kind === 'TASK_NOT_FOUND' || claim.kind === 'PAYLOAD_CONFLICT') {
      return { ack: false, outcome: 'RETRY' };
    }
    if (claim.kind === 'DUPLICATE_PENDING') {
      return { ack: false, outcome: 'DUPLICATE_PENDING' };
    }
    return this.onCancel({ ...message, leaseToken, leaseExpiresAt }, claim.task);
  }

  private async onCancel(message: ActiveMessage, task: SagaTask): Promise<ConsumerResult> {
    const expectedUserId = optionalString(message.data.userId);
    const expectedStatus = optionalString(message.data.currentStatus);
    const expectedVersion = message.data.currentVersion;
    const resumableCancel =
      task.cancelRequested &&
      ((task.financialDisposition === 'PRE_ACCEPTANCE_FULL_RELEASE' &&
        task.status === 'CANCELED') ||
        (task.financialDisposition === 'USER_CANCEL_RULE' &&
          (task.status === 'RUNNING' || task.status === 'CANCELED')));
    if (
      expectedUserId !== task.userId ||
      (!resumableCancel && expectedStatus !== task.status) ||
      (!resumableCancel && expectedVersion !== task.version) ||
      ['SUCCEEDED', 'FAILED', 'EXPIRED', 'SETTLED', 'REFUNDED'].includes(task.status)
    ) {
      await this.completeNoop(message, task);
      return { ack: true, outcome: 'STALE_CANCEL_COMMAND' };
    }
    if (
      !task.providerAccepted &&
      task.providerTaskId === null &&
      (task.status === 'QUEUED' || task.status === 'CANCELED')
    ) {
      const canceled =
        task.status === 'CANCELED'
          ? task
          : await this.writeStatus(message, task, 'CANCELED', 'CANCELED_BEFORE_ACCEPTANCE', {
              providerStateRank: Math.max(task.providerStateRank, 3),
              cancelRequested: true,
              financialDisposition: 'PRE_ACCEPTANCE_FULL_RELEASE',
              financialSettlementKey: null,
              financialReleaseKey: `task:${task.taskId}:pre-acceptance-cancel-release`,
            });
      this.ensureLease(message);
      await this.dependencies.wallet.release(
        ledger({
          businessKey:
            canceled.financialReleaseKey ?? `task:${task.taskId}:pre-acceptance-cancel-release`,
          userId: task.userId,
          kind: 'RELEASE',
          points: task.quotedPoints,
          reason: 'CANCELED_BEFORE_PROVIDER_ACCEPTANCE',
        }),
      );
      return this.finishRefund(message, canceled, 'PRE_ACCEPTANCE_CANCELED');
    }
    if (!task.providerAccepted || task.providerTaskId === null) {
      return this.operatorRequired(
        message,
        task,
        'CANCELLATION_ACCEPTANCE_UNVERIFIABLE',
        'Cancellation cannot proceed because provider acceptance is not verifiable.',
      );
    }
    if (this.dependencies.cancellation === null) {
      return this.operatorRequired(
        message,
        task,
        'REMOTE_CANCELLATION_UNSUPPORTED',
        'The accepted provider task has no supported cancellation operation.',
      );
    }
    if (task.cancellationChargePoints === null) {
      return this.operatorRequired(
        message,
        task,
        'CANCELLATION_RULE_MISSING',
        'The stored cancellation charge rule is unavailable.',
      );
    }
    const intent =
      task.cancelRequested && task.financialDisposition === 'USER_CANCEL_RULE'
        ? task
        : await this.write(
            message,
            task,
            {
              cancelRequested: true,
              financialDisposition: 'USER_CANCEL_RULE',
              financialSettlementKey: `task:${task.taskId}:settle`,
              financialReleaseKey: `task:${task.taskId}:quote-difference-release`,
            },
            [],
            false,
          );
    this.ensureLease(message);
    const remote = await this.dependencies.cancellation.cancel({
      taskId: intent.taskId,
      providerTaskId: String(intent.providerTaskId),
      businessKey: `task:${intent.taskId}:provider-cancel`,
      traceId: message.traceId,
    });
    if (remote.outcome !== 'CONFIRMED') {
      return this.operatorRequired(
        message,
        intent,
        'REMOTE_CANCELLATION_UNCONFIRMED',
        'The provider did not confirm cancellation and billing disposition.',
      );
    }
    const canceled = await this.writeStatus(
      message,
      intent,
      'CANCELED',
      'PROVIDER_CANCEL_CONFIRMED',
      {
        providerStateRank: 3,
      },
    );
    return this.applyCancellationFinance(message, canceled);
  }

  private parse(rawEvent: unknown): ParsedMessage {
    const parsed = EventEnvelopeSchema.strict().safeParse(rawEvent);
    if (!parsed.success || parsed.data.version !== 1) throw new Error('INVALID_GENERATION_EVENT');
    const envelope = parsed.data;
    if (envelope.type === 'generation.task-cancel-requested.v1') {
      const data = CancelRequestedDataSchema.safeParse(envelope.data);
      if (
        !data.success ||
        envelope.producer !== 'generation-service' ||
        envelope.correlationId !== data.data.taskId
      ) {
        throw new Error('INVALID_CANCEL_REQUESTED_EVENT');
      }
      return parsedMessage(envelope, data.data.taskId, data.data, rawEvent);
    }
    if (envelope.type === 'asset.imported.v1') {
      const data = AssetImportedDataSchema.safeParse(envelope.data);
      if (
        !data.success ||
        envelope.producer !== 'asset-service' ||
        envelope.correlationId !== data.data.taskId ||
        data.data.importBusinessKey !== `task:${data.data.taskId}:asset-import`
      ) {
        throw new Error('INVALID_ASSET_IMPORTED_EVENT');
      }
      return parsedMessage(
        envelope,
        data.data.taskId,
        data.data as Record<string, unknown>,
        rawEvent,
      );
    }
    const type = ProviderEventTypeSchema.safeParse(envelope.type);
    const data = ProviderDataSchema.safeParse(envelope.data);
    if (
      !type.success ||
      !data.success ||
      envelope.producer !== 'provider-runtime' ||
      envelope.correlationId !== data.data.taskId ||
      !typeMatchesStatus(type.data, data.data.status) ||
      (data.data.status === 'SUCCEEDED' && data.data.providerTaskId === undefined)
    ) {
      throw new Error('INVALID_PROVIDER_EVENT');
    }
    return parsedMessage(envelope, data.data.taskId, data.data, rawEvent);
  }

  private async claim(message: ParsedMessage): Promise<{
    readonly claim: ClaimMessageResult;
    readonly leaseToken: string;
    readonly leaseExpiresAt: Date;
  }> {
    const receivedAt = this.dependencies.clock.now();
    const ownerId = this.dependencies.ids.next();
    const leaseToken = createHash('sha256')
      .update(`${message.id}:${message.payloadSha256}:${ownerId}`)
      .digest('hex');
    const leaseExpiresAt = new Date(receivedAt.getTime() + this.leaseDurationMs);
    const claim = await this.dependencies.repository.claim({
      consumer: ProviderEventsConsumerName,
      messageId: message.id,
      eventType: message.type,
      payloadSha256: message.payloadSha256,
      taskId: message.taskId,
      receivedAt,
      leaseToken,
      leaseExpiresAt,
    });
    return { claim, leaseToken, leaseExpiresAt };
  }

  private async onProgress(
    message: ActiveMessage,
    task: SagaTask,
    rank: number,
  ): Promise<ConsumerResult> {
    const next = await this.writeStatus(
      message,
      task,
      'RUNNING',
      'PROVIDER_PROGRESS',
      {
        providerAccepted: true,
        providerStateRank: rank,
        providerId: String(message.data.providerId),
        providerTaskId: optionalString(message.data.providerTaskId),
        modelCode: optionalString(message.data.modelCode) ?? task.modelCode,
        executionId: String(message.data.executionId),
      },
      true,
    );
    void next;
    return { ack: true, outcome: 'PROGRESSED' };
  }

  private async onSucceeded(message: ActiveMessage, task: SagaTask): Promise<ConsumerResult> {
    if (task.status === 'SETTLED') {
      await this.completeNoop(message, task);
      return { ack: true, outcome: 'STALE_PROVIDER_EVENT' };
    }
    if (['FAILED', 'CANCELED', 'EXPIRED', 'REFUNDED'].includes(task.status)) {
      await this.completeNoop(message, task);
      return { ack: true, outcome: 'STALE_PROVIDER_EVENT' };
    }
    if (!Array.isArray(message.data.resultUrls) || message.data.resultUrls.length === 0) {
      return this.operatorRequired(
        message,
        task,
        'PROVIDER_SUCCESS_RESULT_MISSING',
        'Provider reported success without a canonical durable result location.',
        this.providerIdentityPatch(message, task),
      );
    }
    const succeeded =
      task.status === 'SUCCEEDED' && task.assetImportRequested
        ? task
        : await this.writeStatus(message, task, 'SUCCEEDED', 'PROVIDER_SUCCEEDED', {
            ...this.providerIdentityPatch(message, task),
            providerAccepted: true,
            providerStateRank: 3,
            assetImportRequested: true,
            assetImportDispatched: false,
          });
    const resultUrls = message.data.resultUrls as readonly string[];
    this.ensureLease(message);
    await this.dependencies.asset.requestImport({
      taskId: succeeded.taskId,
      userId: succeeded.userId,
      resultUrls,
      businessKey: `task:${succeeded.taskId}:asset-import`,
      traceId: message.traceId,
    });
    const current = await this.dependencies.repository.getTask(succeeded.taskId);
    if (current === null) throw new Error('TASK_SAGA_NOT_FOUND');
    if (current.status === 'SETTLED') {
      await this.completeNoop(message, current);
      return { ack: true, outcome: 'SETTLED' };
    }
    await this.write(message, current, { assetImportDispatched: true }, [], true);
    return { ack: true, outcome: 'ASSET_IMPORT_PENDING' };
  }

  private async onAssetImported(message: ActiveMessage, task: SagaTask): Promise<ConsumerResult> {
    if (task.status === 'SETTLED') {
      await this.completeNoop(message, task);
      return { ack: true, outcome: 'STALE_PROVIDER_EVENT' };
    }
    if (task.status !== 'SUCCEEDED' || !task.assetImportRequested) {
      return this.operatorRequired(
        message,
        task,
        'UNEXPECTED_ASSET_IMPORTED_EVENT',
        'An asset import arrived before a durable provider success/import request.',
      );
    }
    const imported = await this.write(
      message,
      task,
      {
        assetId: String(message.data.assetId),
        financialDisposition: 'SUCCESS_SETTLEMENT',
        financialSettlementKey: `task:${task.taskId}:settle`,
        financialReleaseKey: `task:${task.taskId}:quote-difference-release`,
      },
      [],
      false,
    );
    await this.settleAndReleaseDifference(message, imported, 'GENERATION_SUCCEEDED');
    await this.writeStatus(message, imported, 'SETTLED', 'FINANCIAL_EFFECTS_CONFIRMED', {}, true);
    return { ack: true, outcome: 'SETTLED' };
  }

  private async onFailed(
    message: ActiveMessage,
    task: SagaTask,
    reason: 'PROVIDER_FAILED' | 'PROVIDER_CANCELED',
  ): Promise<ConsumerResult> {
    if (task.status === 'REFUNDED') {
      await this.completeNoop(message, task);
      return { ack: true, outcome: 'STALE_PROVIDER_EVENT' };
    }
    if (
      reason === 'PROVIDER_CANCELED' &&
      task.cancelRequested &&
      task.financialDisposition === 'USER_CANCEL_RULE'
    ) {
      const canceled = await this.writeStatus(message, task, 'CANCELED', reason, {
        ...this.providerIdentityPatch(message, task),
        providerStateRank: 3,
      });
      return this.applyCancellationFinance(message, canceled);
    }
    const target = reason === 'PROVIDER_FAILED' ? 'FAILED' : 'CANCELED';
    if (
      task.status !== target &&
      ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED', 'SETTLED'].includes(task.status)
    ) {
      await this.completeNoop(message, task);
      return { ack: true, outcome: 'STALE_PROVIDER_EVENT' };
    }
    const failed = await this.writeStatus(message, task, target, reason, {
      ...this.providerIdentityPatch(message, task),
      providerStateRank: 3,
      financialDisposition:
        reason === 'PROVIDER_FAILED'
          ? 'PROVIDER_FAILED_FULL_RELEASE'
          : 'PROVIDER_CANCELED_FULL_RELEASE',
      financialSettlementKey: null,
      financialReleaseKey: `task:${task.taskId}:provider-failure-release`,
    });
    this.ensureLease(message);
    await this.dependencies.wallet.release(
      ledger({
        businessKey: failed.financialReleaseKey ?? `task:${task.taskId}:provider-failure-release`,
        userId: task.userId,
        kind: 'RELEASE',
        points: task.quotedPoints,
        reason,
      }),
    );
    return this.finishRefund(message, failed, reason);
  }

  private async applyCancellationFinance(
    message: ActiveMessage,
    task: SagaTask,
  ): Promise<ConsumerResult> {
    const charge = points(String(task.cancellationChargePoints));
    const quoted = points(task.quotedPoints);
    if (charge > quoted) {
      return this.operatorRequired(
        message,
        task,
        'CANCELLATION_RULE_EXCEEDS_QUOTE',
        'The stored cancellation charge exceeds the accepted quote.',
      );
    }
    if (charge === 0n) {
      this.ensureLease(message);
      await this.dependencies.wallet.release(
        ledger({
          businessKey: task.financialReleaseKey ?? `task:${task.taskId}:cancel-release`,
          userId: task.userId,
          kind: 'RELEASE',
          points: task.quotedPoints,
          reason: 'PROVIDER_CANCEL_CONFIRMED',
        }),
      );
      return this.finishRefund(message, task, 'PROVIDER_CANCEL_CONFIRMED');
    }
    await this.settleAndReleaseDifference(
      message,
      { ...task, settlementPoints: charge.toString() },
      'PROVIDER_CANCEL_CONFIRMED',
    );
    await this.writeStatus(
      message,
      task,
      'SETTLED',
      'CANCELLATION_FINANCIAL_EFFECTS_CONFIRMED',
      {
        settlementPoints: charge.toString(),
      },
      true,
    );
    return { ack: true, outcome: 'SETTLED' };
  }

  private async settleAndReleaseDifference(
    message: ActiveMessage,
    task: SagaTask,
    reason: string,
  ): Promise<void> {
    const quoted = points(task.quotedPoints);
    const settlement = points(task.settlementPoints);
    if (settlement > quoted) throw new Error('SETTLEMENT_EXCEEDS_QUOTE');
    this.ensureLease(message);
    await this.dependencies.wallet.settle(
      ledger({
        businessKey: task.financialSettlementKey ?? `task:${task.taskId}:settle`,
        userId: task.userId,
        kind: 'SETTLE',
        points: settlement.toString(),
        reason,
      }),
    );
    const difference = quoted - settlement;
    if (difference > 0n) {
      this.ensureLease(message);
      await this.dependencies.wallet.release(
        ledger({
          businessKey: task.financialReleaseKey ?? `task:${task.taskId}:quote-difference-release`,
          userId: task.userId,
          kind: 'RELEASE',
          points: difference.toString(),
          reason: 'QUOTE_DIFFERENCE',
        }),
      );
    }
  }

  private async finishRefund(
    message: ActiveMessage,
    task: SagaTask,
    reasonCode: string,
  ): Promise<ConsumerResult> {
    await this.writeStatus(message, task, 'REFUNDED', `${reasonCode}_REFUNDED`, {}, true);
    return { ack: true, outcome: 'REFUNDED' };
  }

  private async operatorRequired(
    message: ActiveMessage,
    task: SagaTask,
    kind: string,
    summary: string,
    patch: SagaWrite['patch'] = {},
  ): Promise<ConsumerResult> {
    await this.write(
      message,
      task,
      patch,
      [],
      true,
      this.operatorCase(message, task, kind, summary, patch),
    );
    this.dependencies.observer?.incrementRepairCases('AMBIGUOUS_PROVIDER_RESULT');
    return { ack: true, outcome: 'OPERATOR_REQUIRED' };
  }

  private async onAmbiguous(message: ActiveMessage, task: SagaTask): Promise<ConsumerResult> {
    const kind = 'PROVIDER_ACCEPTANCE_AMBIGUOUS';
    const summary = 'Provider acceptance or billing cannot be established automatically.';
    const patch = this.providerIdentityPatch(message, task);
    if (task.status !== 'QUEUED') {
      return this.operatorRequired(message, task, kind, summary, patch);
    }
    transition(task.status, 'SUBMITTING');
    const transitionRecord: SagaTransition = {
      id: this.dependencies.ids.next(),
      fromStatus: 'QUEUED',
      toStatus: 'SUBMITTING',
      taskVersion: task.version + 1,
      reasonCode: 'PROVIDER_SUBMISSION_AMBIGUOUS',
      source: 'WORKER',
      actorType: 'PROVIDER',
      actorId: String(message.data.providerId),
      traceId: message.traceId,
      metadata: { messageId: message.id, eventType: message.type },
      createdAt: message.occurredAt,
    };
    await this.write(
      message,
      task,
      { ...patch, status: 'SUBMITTING' },
      [transitionRecord],
      true,
      this.operatorCase(message, task, kind, summary, patch),
    );
    this.dependencies.observer?.incrementRepairCases('AMBIGUOUS_PROVIDER_RESULT');
    return { ack: true, outcome: 'OPERATOR_REQUIRED' };
  }

  private operatorCase(
    message: ActiveMessage,
    task: SagaTask,
    kind: string,
    summary: string,
    patch: SagaWrite['patch'],
  ): OperatorCaseInput {
    return {
      id: this.dependencies.ids.next(),
      kind,
      summary,
      deduplicationKey: operatorCaseKey(task.taskId, message.id, kind),
      evidence: {
        eventType: message.type,
        messageId: message.id,
        taskId: task.taskId,
        providerAccepted: task.providerAccepted,
        providerId: patch.providerId ?? task.providerId,
        providerTaskId: patch.providerTaskId ?? task.providerTaskId,
        modelCode: patch.modelCode ?? task.modelCode,
        executionId: patch.executionId ?? task.executionId,
        routeEpoch: patch.routeEpoch ?? task.routeEpoch,
      },
    };
  }

  private async completeNoop(message: ActiveMessage, task: SagaTask): Promise<void> {
    await this.write(message, task, {}, [], true);
  }

  private providerBindingMatches(message: ActiveMessage, task: SagaTask): boolean {
    const providerId = String(message.data.providerId);
    const modelCode = optionalString(message.data.modelCode);
    const executionId = String(message.data.executionId);
    return (
      Number(message.data.routeEpoch) === task.routeEpoch &&
      (task.providerId === null || task.providerId === providerId) &&
      (task.modelCode === null || task.modelCode === modelCode) &&
      (task.executionId === null || task.executionId === executionId)
    );
  }

  private providerIdentityPatch(message: ActiveMessage, task: SagaTask): SagaWrite['patch'] {
    return {
      providerId: String(message.data.providerId),
      providerTaskId: optionalString(message.data.providerTaskId),
      modelCode: optionalString(message.data.modelCode) ?? task.modelCode,
      executionId: String(message.data.executionId),
      routeEpoch: Number(message.data.routeEpoch),
    };
  }

  private ensureLease(message: ActiveMessage): void {
    if (this.dependencies.clock.now().getTime() >= message.leaseExpiresAt.getTime()) {
      throw new Error('INBOX_LEASE_EXPIRED');
    }
  }

  private async writeStatus(
    message: ActiveMessage,
    task: SagaTask,
    target: TaskStatus,
    reasonCode: string,
    patch: SagaWrite['patch'],
    completeMessage = false,
  ): Promise<SagaTask> {
    let statuses: readonly TaskStatus[];
    try {
      statuses = taskTransitionPath(task.status, target);
    } catch (error) {
      this.dependencies.observer?.recordTransitionFailure(
        task.status,
        target,
        'ILLEGAL_TRANSITION',
      );
      throw error;
    }
    let from = task.status;
    let version = task.version;
    const transitions: SagaTransition[] = [];
    for (const to of statuses) {
      transition(from, to);
      version += 1;
      transitions.push({
        id: this.dependencies.ids.next(),
        fromStatus: from,
        toStatus: to,
        taskVersion: version,
        reasonCode,
        source: 'WORKER',
        actorType: message.type.startsWith('provider.') ? 'PROVIDER' : 'SERVICE',
        actorId: message.type.startsWith('provider.')
          ? String(message.data.providerId)
          : 'generation-service',
        traceId: message.traceId,
        metadata: { messageId: message.id, eventType: message.type },
        createdAt: message.occurredAt,
      });
      from = to;
    }
    let written: SagaTask;
    try {
      written = await this.write(
        message,
        task,
        { ...patch, status: target },
        transitions,
        completeMessage,
      );
    } catch (error) {
      this.dependencies.observer?.recordTransitionFailure(
        task.status,
        target,
        error instanceof Error && error.message === 'TASK_SAGA_FENCED'
          ? 'VERSION_CONFLICT'
          : 'PERSISTENCE_ERROR',
      );
      throw error;
    }
    for (const item of transitions) this.dependencies.observer?.recordTaskState(item.toStatus);
    if (task.status === 'QUEUED' && target !== 'QUEUED') {
      this.dependencies.observer?.observeQueueAge(
        Math.max(0, (this.dependencies.clock.now().getTime() - task.updatedAt.getTime()) / 1_000),
      );
    }
    return written;
  }

  private async write(
    message: ActiveMessage,
    task: SagaTask,
    patch: SagaWrite['patch'],
    transitions: readonly SagaTransition[],
    completeMessage: boolean,
    operatorCase?: OperatorCaseInput,
  ): Promise<SagaTask> {
    const result = await this.dependencies.repository.write({
      messageId: message.id,
      payloadSha256: message.payloadSha256,
      taskId: task.taskId,
      expectedVersion: task.version,
      expectedSagaVersion: task.sagaVersion,
      leaseToken: message.leaseToken,
      patch,
      transitions,
      occurredAt: message.occurredAt,
      committedAt: this.dependencies.clock.now(),
      completeMessage,
      ...(operatorCase === undefined ? {} : { operatorCase }),
    });
    if (result.kind === 'STALE') throw new Error('TASK_SAGA_FENCED');
    return result.task;
  }
}

export interface ProviderEventDelivery {
  readonly body: unknown;
  ack(): Promise<void>;
  retry(): Promise<void>;
}

export class ProviderEventsDeliveryConsumer {
  constructor(private readonly handler: Pick<ProviderEventsConsumer, 'consume'>) {}

  async consume(delivery: ProviderEventDelivery): Promise<void> {
    try {
      const result = await this.handler.consume(delivery.body);
      if (result.ack) await delivery.ack();
      else await delivery.retry();
    } catch {
      await delivery.retry();
    }
  }
}

function parsedMessage(
  envelope: z.infer<typeof EventEnvelopeSchema>,
  taskId: string,
  data: Record<string, unknown>,
  rawEvent: unknown,
): ParsedMessage {
  return {
    id: envelope.id,
    type: envelope.type,
    taskId,
    traceId: envelope.traceId,
    correlationId: envelope.correlationId,
    occurredAt: new Date(envelope.occurredAt),
    data,
    payloadSha256: sha256(rawEvent),
  };
}

function typeMatchesStatus(type: z.infer<typeof ProviderEventTypeSchema>, status: string): boolean {
  return type === `provider.execution-${status.toLowerCase()}.v1`;
}

export function providerEventStateRank(status: string): number {
  if (status === 'ACCEPTED') return 1;
  if (status === 'RUNNING') return 2;
  if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(status)) return 3;
  return 0;
}

export function taskTransitionPath(current: TaskStatus, target: TaskStatus): readonly TaskStatus[] {
  if (current === target) return [];
  if (target === 'RUNNING') {
    if (current === 'QUEUED') return ['SUBMITTING', 'RUNNING'];
    if (current === 'SUBMITTING') return ['RUNNING'];
  }
  if (target === 'SUCCEEDED') {
    if (current === 'QUEUED') return ['SUBMITTING', 'RUNNING', 'SUCCEEDED'];
    if (current === 'SUBMITTING') return ['RUNNING', 'SUCCEEDED'];
    if (current === 'RUNNING') return ['SUCCEEDED'];
  }
  if (target === 'FAILED') {
    if (current === 'QUEUED') return ['SUBMITTING', 'FAILED'];
    if (current === 'SUBMITTING' || current === 'RUNNING') return ['FAILED'];
  }
  if (target === 'CANCELED' && (current === 'QUEUED' || current === 'RUNNING')) {
    return ['CANCELED'];
  }
  if (target === 'CANCELED' && current === 'SUBMITTING') {
    return ['RUNNING', 'CANCELED'];
  }
  if (target === 'SETTLED' && (current === 'SUCCEEDED' || current === 'CANCELED')) {
    return ['SETTLED'];
  }
  if (
    target === 'REFUNDED' &&
    (current === 'RESERVED' ||
      current === 'FAILED' ||
      current === 'CANCELED' ||
      current === 'EXPIRED')
  ) {
    return ['REFUNDED'];
  }
  throw new Error('ILLEGAL_TASK_TRANSITION');
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function points(value: string): bigint {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error('INVALID_POINTS');
  return BigInt(value);
}

function ledger(command: LedgerCommand): LedgerCommand {
  return LedgerCommandSchema.parse(command);
}

function sha256(value: unknown): string {
  try {
    return createHash('sha256').update(canonicalJson(value)).digest('hex');
  } catch (error) {
    if (error instanceof StrictJsonError)
      throw new Error('INVALID_GENERATION_EVENT', { cause: error });
    throw error;
  }
}

function operatorCaseKey(taskId: string, messageId: string, kind: string): string {
  return `generation-operator:${createHash('sha256')
    .update(`${taskId}:${messageId}:${kind}`)
    .digest('hex')}`;
}
