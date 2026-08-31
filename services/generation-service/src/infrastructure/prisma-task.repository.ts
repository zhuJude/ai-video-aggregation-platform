import { EventEnvelopeSchema } from '@repo/contracts/common';
import type { TaskStatus } from '../domain/task-state-machine.js';
import { UuidV7Generator, type UuidV7Source } from '../domain/uuid-v7.js';
import type {
  AdvanceIdempotencyPhaseInput,
  BeginReservationInput,
  CreateTaskPersistence,
  FinalizeIdempotencyFailureInput,
  IdempotencyClaim,
  IdempotencyRecord,
  PersistTaskInput,
  ReclaimIdempotencyInput,
  RepairRequiredInput,
  TaskCreationPhase,
  TaskCreationRepository,
} from '../application/create-task.service.js';
import type {
  ListTasksQuery,
  OwnedTask,
  TaskCommandRequest,
  TaskManagementRepository,
} from '../application/task-management.service.js';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';

function asJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseIdempotencyResponse(value: Prisma.JsonValue | null): IdempotencyRecord['response'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  if (typeof value.taskId === 'string' && value.status === 'QUEUED' && value.version === 2) {
    return { taskId: value.taskId, status: 'QUEUED', version: 2 };
  }
  if (typeof value.errorCode === 'string') return { errorCode: value.errorCode };
  return null;
}

function toIdempotency(record: {
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
  readonly status: 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED';
  readonly response: Prisma.JsonValue | null;
  readonly taskId: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}): IdempotencyRecord {
  return {
    id: record.id,
    userId: record.userId,
    idempotencyKey: record.idempotencyKey,
    requestSha256: record.requestSha256,
    proposedTaskId: record.proposedTaskId,
    quotedPoints: record.quotedPoints,
    reserveBusinessKey: record.reserveBusinessKey,
    compensationBusinessKey: record.compensationBusinessKey,
    traceId: record.traceId,
    leaseToken: record.leaseToken,
    phase: record.phase,
    status: record.status,
    response: parseIdempotencyResponse(record.response),
    taskId: record.taskId,
    createdAt: record.createdAt,
    expiresAt: record.expiresAt,
  };
}

function toOwnedTask(record: {
  readonly id: string;
  readonly userId: string;
  readonly quoteId: string;
  readonly capabilityVersionId: string;
  readonly status: TaskStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}): OwnedTask {
  return record;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}

export class PrismaTaskRepository implements TaskCreationRepository, TaskManagementRepository {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly ids: UuidV7Source = new UuidV7Generator(),
  ) {}

  async claimIdempotency(claim: IdempotencyClaim): Promise<IdempotencyRecord> {
    try {
      const created = await this.prisma.taskIdempotency.create({
        data: {
          id: claim.id,
          userId: claim.userId,
          idempotencyKey: claim.idempotencyKey,
          requestSha256: claim.requestSha256,
          proposedTaskId: claim.proposedTaskId,
          quotedPoints: claim.quotedPoints,
          reserveBusinessKey: claim.reserveBusinessKey,
          compensationBusinessKey: claim.compensationBusinessKey,
          traceId: claim.traceId,
          leaseToken: claim.leaseToken,
          phase: claim.phase,
          createdAt: claim.createdAt,
          expiresAt: claim.expiresAt,
        },
      });
      return toIdempotency(created);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.taskIdempotency.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: claim.userId,
            idempotencyKey: claim.idempotencyKey,
          },
        },
      });
      if (existing === null) throw error;
      return toIdempotency(existing);
    }
  }

  async getIdempotency(userId: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
    const record = await this.prisma.taskIdempotency.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
    return record === null ? null : toIdempotency(record);
  }

  async tryReclaimIdempotency(input: ReclaimIdempotencyInput): Promise<boolean> {
    const updated = await this.prisma.taskIdempotency.updateMany({
      where: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
        status: 'IN_PROGRESS',
        phase: 'CLAIMED',
        leaseToken: input.expectedLeaseToken,
        expiresAt: { lte: input.now },
      },
      data: { expiresAt: input.expiresAt, leaseToken: input.newLeaseToken },
    });
    return updated.count === 1;
  }

  async tryBeginReservation(input: BeginReservationInput): Promise<boolean> {
    const updated = await this.prisma.taskIdempotency.updateMany({
      where: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
        status: 'IN_PROGRESS',
        phase: 'CLAIMED',
        leaseToken: input.leaseToken,
        expiresAt: { equals: input.expectedExpiresAt, gt: input.now },
      },
      data: { phase: 'RESERVE_REQUESTED' },
    });
    return updated.count === 1;
  }

  async persistTask(input: PersistTaskInput): Promise<CreateTaskPersistence> {
    const response: CreateTaskPersistence = {
      taskId: input.taskId,
      status: 'QUEUED',
      version: 2,
    };
    await this.prisma.$transaction(
      async (transaction) => {
        await transaction.generationTask.create({
          data: {
            id: input.taskId,
            userId: input.userId,
            quoteId: input.quoteId,
            capabilityVersionId: input.capabilityVersionId,
            status: input.status,
            quoteSnapshot: asJson(input.quoteSnapshot),
            quoteSnapshotSha256: input.quoteSnapshotSha256,
            capabilitySnapshot: asJson(input.capabilitySnapshot),
            capabilitySnapshotSha256: input.capabilitySnapshotSha256,
            pricingSnapshot: asJson(input.pricingSnapshot),
            pricingSnapshotSha256: input.pricingSnapshotSha256,
            parametersSnapshot: asJson(input.parametersSnapshot),
            parametersSnapshotSha256: input.parametersSnapshotSha256,
            version: input.version,
            createdAt: input.createdAt,
            updatedAt: input.createdAt,
            transitions: {
              create: input.transitions.map((transition) => ({
                id: transition.id,
                fromStatus: transition.fromStatus,
                toStatus: transition.toStatus,
                taskVersion: transition.taskVersion,
                reasonCode: transition.reasonCode,
                source: transition.source,
                actorType: transition.actorType,
                actorId: transition.actorId,
                traceId: transition.traceId,
                metadata: asJson(transition.metadata),
                createdAt: transition.createdAt,
              })),
            },
          },
        });
        const event = input.event;
        await transaction.outboxEvent.create({
          data: {
            id: event.id,
            aggregateType: 'GenerationTask',
            aggregateId: input.taskId,
            eventType: event.type,
            eventVersion: event.version,
            deduplicationKey: `task:${input.taskId}:queued:v${String(input.version)}`,
            payload: asJson(event.data),
            headers: asJson({
              traceId: event.traceId,
              correlationId: event.correlationId,
              ...(event.causationId === undefined ? {} : { causationId: event.causationId }),
              producer: event.producer,
            }),
            occurredAt: new Date(event.occurredAt),
            availableAt: input.createdAt,
          },
        });
        const updated = await transaction.taskIdempotency.updateMany({
          where: {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
            requestSha256: input.requestSha256,
            leaseToken: input.leaseToken,
            phase: 'RESERVED',
            status: 'IN_PROGRESS',
          },
          data: {
            status: 'SUCCEEDED',
            phase: 'SUCCEEDED',
            taskId: input.taskId,
            response: asJson(response),
          },
        });
        if (updated.count !== 1) throw new Error('IDEMPOTENCY_FINALIZATION_CONFLICT');
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
    return response;
  }

  async markIdempotencyFailed(input: FinalizeIdempotencyFailureInput): Promise<boolean> {
    const updated = await this.prisma.taskIdempotency.updateMany({
      where: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
        leaseToken: input.leaseToken,
        phase: input.expectedPhase,
        status: 'IN_PROGRESS',
        ...(input.expectedPhase === 'CLAIMED'
          ? { expiresAt: { equals: input.expectedExpiresAt, gt: input.now } }
          : {}),
      },
      data: { status: 'FAILED', phase: 'FAILED', response: asJson({ errorCode: input.errorCode }) },
    });
    return updated.count === 1;
  }

  async updateIdempotencyPhase(input: AdvanceIdempotencyPhaseInput): Promise<boolean> {
    const updated = await this.prisma.taskIdempotency.updateMany({
      where: {
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        requestSha256: input.requestSha256,
        leaseToken: input.leaseToken,
        phase: input.expectedPhase,
        status: 'IN_PROGRESS',
      },
      data: { phase: input.nextPhase },
    });
    return updated.count === 1;
  }

  async recordRepairRequired(input: RepairRequiredInput): Promise<boolean> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const idempotency = await transaction.taskIdempotency.findUnique({
            where: {
              userId_idempotencyKey: {
                userId: input.userId,
                idempotencyKey: input.idempotencyKey,
              },
            },
            select: { id: true },
          });
          if (idempotency === null) return false;
          const updated = await transaction.taskIdempotency.updateMany({
            where: {
              id: idempotency.id,
              requestSha256: input.requestSha256,
              leaseToken: input.leaseToken,
              phase: input.phase,
              status: 'IN_PROGRESS',
            },
            data: {
              status: 'FAILED',
              phase: 'REPAIR_REQUIRED',
              response: asJson({ errorCode: 'TASK_CREATION_REPAIR_REQUIRED' }),
            },
          });
          if (updated.count !== 1) return false;
          await transaction.taskRepairCase.create({
            data: {
              id: input.repairCaseId,
              taskId: null,
              idempotencyId: idempotency.id,
              kind: 'TASK_CREATION_FINANCIAL_UNCERTAIN',
              summary: 'A task-creation wallet operation requires reconciliation.',
              evidence: asJson({
                proposedTaskId: input.proposedTaskId,
                userId: input.userId,
                idempotencyKey: input.idempotencyKey,
                quotedPoints: input.quotedPoints,
                reserveBusinessKey: input.reserveBusinessKey,
                compensationBusinessKey: input.compensationBusinessKey,
                traceId: input.traceId,
                phase: input.phase,
                errorCode: input.errorCode,
              }),
              detectedAt: input.detectedAt,
            },
          });
          return true;
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await this.prisma.taskIdempotency.findUnique({
        where: {
          userId_idempotencyKey: {
            userId: input.userId,
            idempotencyKey: input.idempotencyKey,
          },
        },
        select: { leaseToken: true, status: true, repairCases: { select: { id: true }, take: 1 } },
      });
      return (
        existing?.leaseToken === input.leaseToken &&
        existing.status === 'FAILED' &&
        existing.repairCases.length === 1
      );
    }
  }

  async findOwned(userId: string, taskId: string): Promise<OwnedTask | null> {
    const record = await this.prisma.generationTask.findFirst({
      where: { id: taskId, userId },
      select: {
        id: true,
        userId: true,
        quoteId: true,
        capabilityVersionId: true,
        status: true,
        version: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return record === null ? null : toOwnedTask(record);
  }

  async listOwned(query: ListTasksQuery): Promise<readonly OwnedTask[]> {
    const cursorFilter =
      query.after === undefined
        ? {}
        : {
            OR: [
              { createdAt: { lt: query.after.createdAt } },
              { createdAt: query.after.createdAt, id: { lt: query.after.id } },
            ],
          };
    const records = await this.prisma.generationTask.findMany({
      where: { userId: query.userId, ...cursorFilter },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit,
      select: {
        id: true,
        userId: true,
        quoteId: true,
        capabilityVersionId: true,
        status: true,
        version: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return records.map(toOwnedTask);
  }

  async requestCommand(input: TaskCommandRequest): Promise<OwnedTask | null> {
    try {
      return await this.prisma.$transaction(
        async (transaction) => {
          const record = await transaction.generationTask.findFirst({
            where: {
              id: input.taskId,
              userId: input.userId,
              status: { in: [...input.allowedStatuses] },
            },
            select: {
              id: true,
              userId: true,
              quoteId: true,
              capabilityVersionId: true,
              status: true,
              version: true,
              createdAt: true,
              updatedAt: true,
            },
          });
          if (record === null) return null;

          const now = new Date();
          const event = EventEnvelopeSchema.parse({
            id: this.ids.next(),
            type: 'generation.task-cancel-requested.v1',
            version: 1,
            occurredAt: now.toISOString(),
            traceId: input.traceId,
            correlationId: input.taskId,
            causationId: input.taskId,
            producer: 'generation-service',
            data: {
              taskId: input.taskId,
              userId: input.userId,
              currentStatus: record.status,
              currentVersion: record.version,
            },
          });
          await transaction.outboxEvent.create({
            data: {
              id: event.id,
              aggregateType: 'GenerationTask',
              aggregateId: input.taskId,
              eventType: event.type,
              eventVersion: event.version,
              deduplicationKey: `task:${input.taskId}:${input.type.toLowerCase()}:v${String(record.version)}`,
              payload: asJson(event.data),
              headers: asJson({
                traceId: event.traceId,
                correlationId: event.correlationId,
                causationId: event.causationId,
                producer: event.producer,
              }),
              occurredAt: now,
              availableAt: now,
            },
          });
          return toOwnedTask(record);
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      return this.findOwned(input.userId, input.taskId);
    }
  }
}
