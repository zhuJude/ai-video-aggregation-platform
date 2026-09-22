import type { TaskStatus } from '../domain/task-state-machine.js';
import { GenerationApplicationError } from './errors.js';
import { TaskCursorCodec, type TaskCursor } from './task-cursor.js';
import type { GenerationDomainObserver } from './observability.js';

export interface OwnedTask {
  readonly id: string;
  readonly userId: string;
  readonly quoteId: string;
  readonly capabilityVersionId: string;
  readonly status: TaskStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListTasksQuery {
  readonly userId: string;
  readonly after?: TaskCursor;
  readonly limit: number;
}

export interface TaskCommandRequest {
  readonly userId: string;
  readonly taskId: string;
  readonly type: 'CANCEL';
  readonly allowedStatuses: readonly TaskStatus[];
  readonly traceId: string;
}

export interface TaskManagementRepository {
  findOwned(userId: string, taskId: string): Promise<OwnedTask | null>;
  listOwned(query: ListTasksQuery): Promise<readonly OwnedTask[]>;
  requestCommand(input: TaskCommandRequest): Promise<OwnedTask | null>;
}

export interface TaskListResult {
  readonly items: readonly OwnedTask[];
  readonly nextCursor?: string;
}

export interface TaskCommandResult {
  readonly accepted: true;
  readonly taskId: string;
  readonly status: TaskStatus;
}

const cancelStatuses = ['QUEUED', 'RUNNING'] as const satisfies readonly TaskStatus[];
const retryStatuses = ['FAILED', 'REFUNDED'] as const satisfies readonly TaskStatus[];

export class TaskManagementService {
  constructor(
    private readonly repository: TaskManagementRepository,
    private readonly cursors = new TaskCursorCodec(),
    private readonly observer?: GenerationDomainObserver,
  ) {}

  async list(
    userId: string,
    request: { readonly cursor?: string; readonly limit?: number },
  ): Promise<TaskListResult> {
    const limit = Math.min(Math.max(request.limit ?? 20, 1), 100);
    const after = request.cursor === undefined ? undefined : this.cursors.decode(request.cursor);
    const query: ListTasksQuery =
      after === undefined ? { userId, limit: limit + 1 } : { userId, after, limit: limit + 1 };
    const rows = await this.repository.listOwned(query);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last !== undefined
        ? this.cursors.encode({ createdAt: last.createdAt, id: last.id })
        : undefined;
    return nextCursor === undefined ? { items } : { items, nextCursor };
  }

  async get(userId: string, taskId: string): Promise<OwnedTask> {
    const found = await this.repository.findOwned(userId, taskId);
    if (found === null) throw new GenerationApplicationError('TASK_NOT_FOUND');
    return found;
  }

  async cancel(userId: string, taskId: string, traceId: string): Promise<TaskCommandResult> {
    return this.command(userId, taskId, traceId, 'CANCEL', cancelStatuses);
  }

  async assertRetryable(userId: string, taskId: string): Promise<OwnedTask> {
    const task = await this.get(userId, taskId);
    if (!retryStatuses.some((status) => status === task.status)) {
      this.observer?.recordTransitionFailure(task.status, 'QUEUED', 'ILLEGAL_TRANSITION');
      throw new GenerationApplicationError('TASK_STATE_CONFLICT');
    }
    return task;
  }

  private async command(
    userId: string,
    taskId: string,
    traceId: string,
    type: TaskCommandRequest['type'],
    allowedStatuses: readonly TaskStatus[],
  ): Promise<TaskCommandResult> {
    await this.get(userId, taskId);
    const accepted = await this.repository.requestCommand({
      userId,
      taskId,
      type,
      allowedStatuses,
      traceId,
    });
    if (accepted === null) {
      const current = await this.get(userId, taskId);
      this.observer?.recordTransitionFailure(current.status, 'CANCELED', 'ILLEGAL_TRANSITION');
      throw new GenerationApplicationError('TASK_STATE_CONFLICT');
    }
    return { accepted: true, taskId: accepted.id, status: accepted.status };
  }
}
