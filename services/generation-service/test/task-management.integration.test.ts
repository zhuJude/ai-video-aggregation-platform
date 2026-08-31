/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it, vi } from 'vitest';
import type { TaskStatus } from '../src/domain/task-state-machine.js';
import {
  TaskManagementService,
  type ListTasksQuery,
  type OwnedTask,
  type TaskManagementRepository,
} from '../src/application/task-management.service.js';
import { TaskCursorCodec } from '../src/application/task-cursor.js';

const USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const OTHER_USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a9';
const TASK_A = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const TASK_B = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';

function task(id: string, userId: string, status: TaskStatus, createdAt: string): OwnedTask {
  return {
    id,
    userId,
    quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
    capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
    status,
    version: 2,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
  };
}

class MemoryManagementRepository implements TaskManagementRepository {
  readonly tasks = new Map<string, OwnedTask>();
  readonly commands: Array<{ type: string; taskId: string }> = [];

  async findOwned(userId: string, taskId: string): Promise<OwnedTask | null> {
    const found = this.tasks.get(taskId);
    return found?.userId === userId ? found : null;
  }

  async listOwned(query: ListTasksQuery): Promise<readonly OwnedTask[]> {
    return [...this.tasks.values()]
      .filter((item) => item.userId === query.userId)
      .filter((item) => {
        if (query.after === undefined) return true;
        return (
          item.createdAt < query.after.createdAt ||
          (item.createdAt.getTime() === query.after.createdAt.getTime() && item.id < query.after.id)
        );
      })
      .sort((left, right) => {
        const byTime = right.createdAt.getTime() - left.createdAt.getTime();
        return byTime === 0 ? right.id.localeCompare(left.id) : byTime;
      })
      .slice(0, query.limit);
  }

  async requestCommand(input: {
    userId: string;
    taskId: string;
    type: 'CANCEL' | 'RETRY';
    allowedStatuses: readonly TaskStatus[];
    traceId: string;
  }): Promise<OwnedTask | null> {
    const found = await this.findOwned(input.userId, input.taskId);
    if (found === null || !input.allowedStatuses.includes(found.status)) return null;
    this.commands.push({ type: input.type, taskId: input.taskId });
    return found;
  }
}

describe('TaskManagementService', () => {
  it('uses a deterministic createdAt/id tie-breaker cursor for owned task pagination', async () => {
    const repository = new MemoryManagementRepository();
    repository.tasks.set(TASK_A, task(TASK_A, USER_ID, 'QUEUED', '2026-08-31T08:00:00Z'));
    repository.tasks.set(TASK_B, task(TASK_B, USER_ID, 'RUNNING', '2026-08-31T08:00:00Z'));
    repository.tasks.set(
      '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2',
      task('0198f4d4-21c2-7b7d-8a03-08a0da2a51b2', OTHER_USER_ID, 'QUEUED', '2026-08-31T09:00:00Z'),
    );
    const service = new TaskManagementService(repository, new TaskCursorCodec());

    const first = await service.list(USER_ID, { limit: 1 });
    if (first.nextCursor === undefined) throw new Error('EXPECTED_NEXT_CURSOR');
    const second = await service.list(USER_ID, { limit: 1, cursor: first.nextCursor });

    expect(first.items.map(({ id }) => id)).toEqual([TASK_B]);
    expect(second.items.map(({ id }) => id)).toEqual([TASK_A]);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(second.nextCursor).toBeUndefined();
  });

  it('does not reveal that another user owns a requested task', async () => {
    const repository = new MemoryManagementRepository();
    repository.tasks.set(TASK_A, task(TASK_A, OTHER_USER_ID, 'QUEUED', '2026-08-31T08:00:00Z'));
    const service = new TaskManagementService(repository, new TaskCursorCodec());

    await expect(service.get(USER_ID, TASK_A)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(service.cancel(USER_ID, TASK_A, 'a'.repeat(32))).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    await expect(service.assertRetryable(USER_ID, TASK_A)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
  });

  it('queues cancellation only for state-machine cancellable states', async () => {
    const repository = new MemoryManagementRepository();
    repository.tasks.set(TASK_A, task(TASK_A, USER_ID, 'RUNNING', '2026-08-31T08:00:00Z'));
    repository.tasks.set(TASK_B, task(TASK_B, USER_ID, 'SUCCEEDED', '2026-08-31T08:01:00Z'));
    const requestSpy = vi.spyOn(repository, 'requestCommand');
    const service = new TaskManagementService(repository, new TaskCursorCodec());

    await expect(service.cancel(USER_ID, TASK_A, 'a'.repeat(32))).resolves.toMatchObject({
      accepted: true,
      taskId: TASK_A,
      status: 'RUNNING',
    });
    await expect(service.cancel(USER_ID, TASK_B, 'a'.repeat(32))).rejects.toMatchObject({
      code: 'TASK_STATE_CONFLICT',
    });
    expect(requestSpy).toHaveBeenCalledTimes(2);
    expect(repository.commands).toEqual([{ type: 'CANCEL', taskId: TASK_A }]);
  });

  it('authorizes a new quoted task only from failed or refunded source work', async () => {
    const repository = new MemoryManagementRepository();
    repository.tasks.set(TASK_A, task(TASK_A, USER_ID, 'FAILED', '2026-08-31T08:00:00Z'));
    repository.tasks.set(TASK_B, task(TASK_B, USER_ID, 'RUNNING', '2026-08-31T08:01:00Z'));
    const service = new TaskManagementService(repository, new TaskCursorCodec());

    await expect(service.assertRetryable(USER_ID, TASK_A)).resolves.toMatchObject({
      id: TASK_A,
      status: 'FAILED',
    });
    await expect(service.assertRetryable(USER_ID, TASK_B)).rejects.toMatchObject({
      code: 'TASK_STATE_CONFLICT',
    });
    expect(repository.commands).toEqual([]);
  });

  it('rejects malformed opaque cursors without passing them to persistence', async () => {
    const repository = new MemoryManagementRepository();
    const service = new TaskManagementService(repository, new TaskCursorCodec());

    await expect(service.list(USER_ID, { cursor: 'not-a-cursor' })).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
  });
});
