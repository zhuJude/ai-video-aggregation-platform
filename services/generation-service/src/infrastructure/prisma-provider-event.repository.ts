import type { TaskStatus } from '../domain/task-state-machine.js';
import type {
  ClaimMessageInput,
  ClaimMessageResult,
  FailoverCandidate,
  ProviderEventRepository,
  SagaTask,
  SagaWrite,
  StaleTaskQuery,
} from '../application/provider-events.consumer.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

class SagaFencedError extends Error {}

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

type DurableTask = {
  readonly id: string;
  readonly userId: string;
  readonly quoteId: string;
  readonly status: TaskStatus;
  readonly version: number;
  readonly capabilityVersionId: string;
  readonly parametersSnapshotSha256: string;
  readonly updatedAt: Date;
  readonly saga: {
    readonly version: number;
    readonly quotedPoints: string;
    readonly settlementPoints: string;
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
    readonly financialDisposition: string | null;
    readonly financialSettlementKey: string | null;
    readonly financialReleaseKey: string | null;
    readonly substitute: Prisma.JsonValue | null;
  } | null;
};

const taskSelection = {
  id: true,
  userId: true,
  quoteId: true,
  status: true,
  version: true,
  capabilityVersionId: true,
  parametersSnapshotSha256: true,
  updatedAt: true,
  saga: {
    select: {
      version: true,
      quotedPoints: true,
      settlementPoints: true,
      providerAccepted: true,
      providerStateRank: true,
      providerId: true,
      providerTaskId: true,
      modelCode: true,
      executionId: true,
      routeEpoch: true,
      assetImportRequested: true,
      assetImportDispatched: true,
      assetId: true,
      routingFailoverAuthorized: true,
      cancellationChargePoints: true,
      cancelRequested: true,
      financialDisposition: true,
      financialSettlementKey: true,
      financialReleaseKey: true,
      substitute: true,
    },
  },
} as const;

export class PrismaProviderEventRepository implements ProviderEventRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(input: ClaimMessageInput): Promise<ClaimMessageResult> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          await transaction.inboxMessage.create({
            data: {
              id: input.messageId,
              consumer: input.consumer,
              messageId: input.messageId,
              eventType: input.eventType,
              payloadSha256: input.payloadSha256,
              receivedAt: input.receivedAt,
              leaseToken: input.leaseToken,
              leaseExpiresAt: input.leaseExpiresAt,
            },
          });
          const task = await transaction.generationTask.findUnique({
            where: { id: input.taskId },
            select: taskSelection,
          });
          return task === null || task.saga === null
            ? ({ kind: 'TASK_NOT_FOUND' } as const)
            : ({ kind: 'CLAIMED', task: toSagaTask(task as DurableTask) } as const);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.reclaim(input);
    }
  }

  async renewLease(input: {
    readonly messageId: string;
    readonly payloadSha256: string;
    readonly leaseToken: string;
    readonly leaseDurationMs: number;
  }): Promise<{ readonly kind: 'RENEWED' } | { readonly kind: 'FENCED' }> {
    const renewed = await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE "InboxMessage"
        SET "leaseExpiresAt" = CURRENT_TIMESTAMP + (${input.leaseDurationMs} * INTERVAL '1 millisecond')
        WHERE "consumer" = 'generation-service:provider-events:v1'
          AND "messageId" = ${input.messageId}
          AND "payloadSha256" = ${input.payloadSha256}
          AND "leaseToken" = ${input.leaseToken}
          AND "processedAt" IS NULL
          AND "leaseExpiresAt" > CURRENT_TIMESTAMP
      `,
    );
    return renewed === 1 ? { kind: 'RENEWED' } : { kind: 'FENCED' };
  }

  async write(
    input: SagaWrite,
  ): Promise<{ readonly kind: 'APPLIED'; readonly task: SagaTask } | { readonly kind: 'STALE' }> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const ownedLease = await transaction.$executeRaw(
            Prisma.sql`
              UPDATE "InboxMessage"
              SET "lastError" = NULL
              WHERE "consumer" = 'generation-service:provider-events:v1'
                AND "messageId" = ${input.messageId}
                AND "payloadSha256" = ${input.payloadSha256}
                AND "leaseToken" = ${input.leaseToken}
                AND "processedAt" IS NULL
                AND "leaseExpiresAt" > CURRENT_TIMESTAMP
            `,
          );
          if (ownedLease !== 1) throw new SagaFencedError('INBOX_LEASE_FENCED');

          const nextVersion = input.transitions.at(-1)?.taskVersion ?? input.expectedVersion;
          const taskUpdated = await transaction.generationTask.updateMany({
            where: { id: input.taskId, version: input.expectedVersion },
            data: {
              ...(input.patch.status === undefined ? {} : { status: input.patch.status }),
              version: nextVersion,
              updatedAt: input.committedAt,
            },
          });
          if (taskUpdated.count !== 1) throw new SagaFencedError('TASK_VERSION_FENCED');

          const sagaData = sagaPatch(input.patch);
          const sagaUpdated = await transaction.taskSaga.updateMany({
            where: { taskId: input.taskId, version: input.expectedSagaVersion },
            data: { ...sagaData, version: { increment: 1 }, updatedAt: input.committedAt },
          });
          if (sagaUpdated.count !== 1) throw new SagaFencedError('SAGA_VERSION_FENCED');

          if (input.transitions.length > 0) {
            await transaction.taskTransition.createMany({
              data: input.transitions.map((item) => ({
                id: item.id,
                taskId: input.taskId,
                fromStatus: item.fromStatus,
                toStatus: item.toStatus,
                taskVersion: item.taskVersion,
                reasonCode: item.reasonCode,
                source: item.source,
                actorType: item.actorType,
                actorId: item.actorId,
                traceId: item.traceId,
                metadata: asJson(item.metadata),
                createdAt: item.createdAt,
              })),
            });
          }
          if (input.operatorCase !== undefined) {
            const caseData = {
              id: input.operatorCase.id,
              taskId: input.taskId,
              idempotencyId: null,
              kind: input.operatorCase.kind,
              summary: input.operatorCase.summary,
              evidence: asJson(input.operatorCase.evidence),
              detectedAt: input.committedAt,
              status: input.operatorCase.status ?? ('OPEN' as const),
              ...(input.operatorCase.status === 'RESOLVED'
                ? { resolvedAt: input.committedAt, resolution: asJson({ automatic: true }) }
                : {}),
              deduplicationKey:
                input.operatorCase.deduplicationKey ??
                `${input.messageId}:${input.operatorCase.kind}`,
            };
            if (input.operatorCase.deduplicationKey === undefined) {
              await transaction.taskRepairCase.create({ data: caseData });
            } else {
              await transaction.taskRepairCase.upsert({
                where: { deduplicationKey: input.operatorCase.deduplicationKey },
                create: caseData,
                update: {},
              });
            }
          }
          if (input.outbox !== undefined) {
            await transaction.outboxEvent.create({
              data: {
                id: input.outbox.id,
                aggregateType: 'GenerationTask',
                aggregateId: input.taskId,
                eventType: input.outbox.eventType,
                eventVersion: 1,
                deduplicationKey: input.outbox.deduplicationKey,
                payload: asJson(input.outbox.payload),
                headers: asJson(input.outbox.headers),
                occurredAt: input.outbox.occurredAt,
                availableAt: input.outbox.availableAt,
              },
            });
          }
          if (input.completeMessage) {
            const completed = await transaction.inboxMessage.updateMany({
              where: {
                consumer: 'generation-service:provider-events:v1',
                messageId: input.messageId,
                payloadSha256: input.payloadSha256,
                leaseToken: input.leaseToken,
                processedAt: null,
              },
              data: {
                processedAt: input.committedAt,
                leaseExpiresAt: null,
                lastError: null,
              },
            });
            if (completed.count !== 1) throw new SagaFencedError('INBOX_LEASE_FENCED');
          }
          const task = await transaction.generationTask.findUnique({
            where: { id: input.taskId },
            select: taskSelection,
          });
          if (task === null || task.saga === null) throw new SagaFencedError('TASK_SAGA_MISSING');
          return { kind: 'APPLIED' as const, task: toSagaTask(task as DurableTask) };
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (error instanceof SagaFencedError || isUniqueViolation(error)) return { kind: 'STALE' };
      throw error;
    }
  }

  async getTask(taskId: string): Promise<SagaTask | null> {
    const task = await this.prisma.generationTask.findUnique({
      where: { id: taskId },
      select: taskSelection,
    });
    return task === null || task.saga === null ? null : toSagaTask(task as DurableTask);
  }

  async findStale(query: StaleTaskQuery): Promise<readonly SagaTask[]> {
    const filters = Object.entries(query.deadlinesMs).map(([status, deadline]) => ({
      status: status as TaskStatus,
      updatedAt: { lte: new Date(query.now.getTime() - deadline) },
    }));
    if (filters.length === 0) return [];
    const tasks = await this.prisma.generationTask.findMany({
      where: { OR: filters },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: query.limit,
      select: taskSelection,
    });
    return (tasks as DurableTask[])
      .filter((task): task is DurableTask & { saga: NonNullable<DurableTask['saga']> } =>
        Boolean(task.saga),
      )
      .map(toSagaTask);
  }

  private async reclaim(input: ClaimMessageInput): Promise<ClaimMessageResult> {
    const existing = await this.prisma.inboxMessage.findUnique({
      where: {
        consumer_messageId: { consumer: input.consumer, messageId: input.messageId },
      },
    });
    if (existing === null) throw new Error('INBOX_UNIQUE_CONFLICT_WITHOUT_ROW');
    if (existing.payloadSha256 !== input.payloadSha256 || existing.eventType !== input.eventType) {
      return { kind: 'PAYLOAD_CONFLICT' };
    }
    if (existing.processedAt !== null) return { kind: 'DUPLICATE_COMPLETE' };
    if (
      existing.leaseToken !== input.leaseToken &&
      existing.leaseExpiresAt !== null &&
      existing.leaseExpiresAt > input.receivedAt
    ) {
      return this.pendingTask(input.taskId, false);
    }
    if (existing.leaseToken !== input.leaseToken) {
      const reclaimed = await this.prisma.inboxMessage.updateMany({
        where: {
          id: existing.id,
          processedAt: null,
          leaseToken: existing.leaseToken,
          leaseExpiresAt: existing.leaseExpiresAt,
        },
        data: { leaseToken: input.leaseToken, leaseExpiresAt: input.leaseExpiresAt },
      });
      if (reclaimed.count !== 1) {
        return this.pendingTask(input.taskId, false);
      }
      return this.pendingTask(input.taskId, true);
    }
    return this.pendingTask(input.taskId, false);
  }

  private async pendingTask(taskId: string, claimed: boolean): Promise<ClaimMessageResult> {
    const task = await this.getTask(taskId);
    if (task === null) return { kind: 'TASK_NOT_FOUND' };
    return claimed ? { kind: 'CLAIMED', task } : { kind: 'DUPLICATE_PENDING', task };
  }
}

function parseFinancialDisposition(value: string | null): SagaTask['financialDisposition'] {
  if (
    value === null ||
    [
      'SUCCESS_SETTLEMENT',
      'PROVIDER_FAILED_FULL_RELEASE',
      'PROVIDER_CANCELED_FULL_RELEASE',
      'PRE_ACCEPTANCE_FULL_RELEASE',
      'EXPIRED_FULL_RELEASE',
      'USER_CANCEL_RULE',
    ].includes(value)
  ) {
    return value as SagaTask['financialDisposition'];
  }
  throw new Error('INVALID_FINANCIAL_DISPOSITION');
}

function toSagaTask(task: DurableTask): SagaTask {
  if (task.saga === null) throw new Error('TASK_SAGA_NOT_FOUND');
  return {
    taskId: task.id,
    userId: task.userId,
    quoteId: task.quoteId,
    status: task.status,
    version: task.version,
    sagaVersion: task.saga.version,
    quotedPoints: task.saga.quotedPoints,
    settlementPoints: task.saga.settlementPoints,
    capabilityVersionId: task.capabilityVersionId,
    parametersSnapshotSha256: task.parametersSnapshotSha256,
    providerAccepted: task.saga.providerAccepted,
    providerStateRank: task.saga.providerStateRank,
    providerId: task.saga.providerId,
    providerTaskId: task.saga.providerTaskId,
    modelCode: task.saga.modelCode,
    executionId: task.saga.executionId,
    routeEpoch: task.saga.routeEpoch,
    assetImportRequested: task.saga.assetImportRequested,
    assetImportDispatched: task.saga.assetImportDispatched,
    assetId: task.saga.assetId,
    routingFailoverAuthorized: task.saga.routingFailoverAuthorized,
    cancellationChargePoints: task.saga.cancellationChargePoints,
    cancelRequested: task.saga.cancelRequested,
    financialDisposition: parseFinancialDisposition(task.saga.financialDisposition),
    financialSettlementKey: task.saga.financialSettlementKey,
    financialReleaseKey: task.saga.financialReleaseKey,
    substitute: parseSubstitute(task.saga.substitute),
    updatedAt: task.updatedAt,
  };
}

function parseSubstitute(value: Prisma.JsonValue | null): FailoverCandidate | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, Prisma.JsonValue>;
  return typeof candidate.providerId === 'string' &&
    typeof candidate.modelCode === 'string' &&
    typeof candidate.capabilityVersionId === 'string' &&
    typeof candidate.pricePoints === 'string'
    ? {
        providerId: candidate.providerId,
        modelCode: candidate.modelCode,
        capabilityVersionId: candidate.capabilityVersionId,
        pricePoints: candidate.pricePoints,
      }
    : null;
}

function sagaPatch(patch: SagaWrite['patch']) {
  return {
    ...(patch.settlementPoints === undefined ? {} : { settlementPoints: patch.settlementPoints }),
    ...(patch.providerAccepted === undefined ? {} : { providerAccepted: patch.providerAccepted }),
    ...(patch.providerStateRank === undefined
      ? {}
      : { providerStateRank: patch.providerStateRank }),
    ...(patch.providerId === undefined ? {} : { providerId: patch.providerId }),
    ...(patch.providerTaskId === undefined ? {} : { providerTaskId: patch.providerTaskId }),
    ...(patch.modelCode === undefined ? {} : { modelCode: patch.modelCode }),
    ...(patch.executionId === undefined ? {} : { executionId: patch.executionId }),
    ...(patch.routeEpoch === undefined ? {} : { routeEpoch: patch.routeEpoch }),
    ...(patch.assetImportRequested === undefined
      ? {}
      : { assetImportRequested: patch.assetImportRequested }),
    ...(patch.assetImportDispatched === undefined
      ? {}
      : { assetImportDispatched: patch.assetImportDispatched }),
    ...(patch.assetId === undefined ? {} : { assetId: patch.assetId }),
    ...(patch.routingFailoverAuthorized === undefined
      ? {}
      : { routingFailoverAuthorized: patch.routingFailoverAuthorized }),
    ...(patch.cancellationChargePoints === undefined
      ? {}
      : { cancellationChargePoints: patch.cancellationChargePoints }),
    ...(patch.cancelRequested === undefined ? {} : { cancelRequested: patch.cancelRequested }),
    ...(patch.financialDisposition === undefined
      ? {}
      : { financialDisposition: patch.financialDisposition }),
    ...(patch.financialSettlementKey === undefined
      ? {}
      : { financialSettlementKey: patch.financialSettlementKey }),
    ...(patch.financialReleaseKey === undefined
      ? {}
      : { financialReleaseKey: patch.financialReleaseKey }),
    ...(patch.substitute === undefined
      ? {}
      : { substitute: patch.substitute === null ? Prisma.JsonNull : asJson(patch.substitute) }),
  };
}
