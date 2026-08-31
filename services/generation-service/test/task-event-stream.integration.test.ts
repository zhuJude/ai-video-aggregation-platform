/* eslint-disable @typescript-eslint/require-await */
import { firstValueFrom, Subject, take, toArray } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import {
  PrismaTaskEventStream,
  type TransitionNotification,
} from '../src/infrastructure/prisma-task-event-stream.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const TRANSITION_A = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';
const TRANSITION_B = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2';

describe('PrismaTaskEventStream', () => {
  it('replays once from a stable cursor and then follows notifications without polling', async () => {
    const durableRows: Array<{
      id: string;
      taskId: string;
      taskVersion: number;
      toStatus: 'RUNNING' | 'SUCCEEDED';
      createdAt: Date;
    }> = [
      {
        id: TRANSITION_A,
        taskId: TASK_ID,
        taskVersion: 3,
        toStatus: 'RUNNING' as const,
        createdAt: new Date('2026-08-31T08:00:00.000Z'),
      },
    ];
    const findMany = vi.fn(async () => [...durableRows]);
    const findFirst = vi.fn(async () => ({ id: TRANSITION_A }));
    const prisma = {
      taskTransition: { findFirst, findMany },
    } as unknown as PrismaClient;
    const notifications = new Subject<TransitionNotification>();
    const stream = new PrismaTaskEventStream(prisma, notifications);

    const resultPromise = firstValueFrom(
      stream
        .stream({
          taskId: TASK_ID,
          after: { taskVersion: 2, transitionId: TRANSITION_A },
        })
        .pipe(take(2), toArray()),
    );
    await vi.waitFor(() => {
      expect(findMany).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    durableRows.push({
      id: TRANSITION_B,
      taskId: TASK_ID,
      taskVersion: 4,
      toStatus: 'SUCCEEDED' as const,
      createdAt: new Date('2026-08-31T08:01:00.000Z'),
    });
    notifications.next({
      transitionId: TRANSITION_B,
      taskId: TASK_ID,
      taskVersion: 4,
      status: 'SUCCEEDED',
      occurredAt: '2026-08-31T08:01:00.000Z',
    });

    await expect(resultPromise).resolves.toMatchObject([
      { transitionId: TRANSITION_A, taskVersion: 3, status: 'RUNNING' },
      { transitionId: TRANSITION_B, taskVersion: 4, status: 'SUCCEEDED' },
    ]);
    expect(findMany).toHaveBeenCalled();
  });

  it('uses out-of-order duplicate live notifications only to wake ordered durable catch-up', async () => {
    const TRANSITION_C = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b3';
    let rows: Array<{
      id: string;
      taskId: string;
      taskVersion: number;
      toStatus: 'RUNNING' | 'SUCCEEDED';
      createdAt: Date;
    }> = [];
    let initialQueryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      initialQueryStarted = resolve;
    });
    const findMany = vi.fn(async () => {
      initialQueryStarted();
      return [...rows].sort((left, right) => left.taskVersion - right.taskVersion);
    });
    const prisma = {
      taskTransition: { findFirst: vi.fn(), findMany },
    } as unknown as PrismaClient;
    const notifications = new Subject<TransitionNotification>();
    const stream = new PrismaTaskEventStream(prisma, notifications);
    const resultPromise = firstValueFrom(stream.stream({ taskId: TASK_ID }).pipe(toArray()));

    await started;
    await Promise.resolve();
    rows = [
      {
        id: TRANSITION_C,
        taskId: TASK_ID,
        taskVersion: 3,
        toStatus: 'RUNNING',
        createdAt: new Date('2026-08-31T08:02:00.000Z'),
      },
      {
        id: TRANSITION_B,
        taskId: TASK_ID,
        taskVersion: 4,
        toStatus: 'SUCCEEDED',
        createdAt: new Date('2026-08-31T08:03:00.000Z'),
      },
    ];
    const misleadingNotification = {
      transitionId: TRANSITION_B,
      taskId: TASK_ID,
      taskVersion: 4,
      status: 'RUNNING' as const,
      occurredAt: '1999-01-01T00:00:00.000Z',
    };
    notifications.next(misleadingNotification);
    notifications.next({ ...misleadingNotification, transitionId: TRANSITION_C, taskVersion: 3 });
    notifications.next(misleadingNotification);
    notifications.complete();

    await expect(resultPromise).resolves.toEqual([
      {
        transitionId: TRANSITION_C,
        taskId: TASK_ID,
        taskVersion: 3,
        status: 'RUNNING',
        occurredAt: '2026-08-31T08:02:00.000Z',
      },
      {
        transitionId: TRANSITION_B,
        taskId: TASK_ID,
        taskVersion: 4,
        status: 'SUCCEEDED',
        occurredAt: '2026-08-31T08:03:00.000Z',
      },
    ]);
    expect(findMany.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('coalesces a burst of wakeups while one durable catch-up query is blocked', async () => {
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    let blockedQueryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      blockedQueryStarted = resolve;
    });
    let call = 0;
    const findMany = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        blockedQueryStarted();
        await blocked;
      }
      return [];
    });
    const prisma = {
      taskTransition: { findFirst: vi.fn(), findMany },
    } as unknown as PrismaClient;
    const notifications = new Subject<TransitionNotification>();
    const subscription = new PrismaTaskEventStream(prisma, notifications)
      .stream({ taskId: TASK_ID })
      .subscribe();
    await vi.waitFor(() => {
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    const notification = {
      transitionId: TRANSITION_A,
      taskId: TASK_ID,
      taskVersion: 3,
      status: 'RUNNING' as const,
      occurredAt: '2026-08-31T08:00:00.000Z',
    };
    notifications.next(notification);
    await started;
    for (let index = 0; index < 25; index += 1) notifications.next(notification);
    releaseBlocked();

    await vi.waitFor(() => {
      expect(findMany.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
    await Promise.resolve();
    expect(findMany).toHaveBeenCalledTimes(3);
    subscription.unsubscribe();
  });

  it('does not start queued durable queries after stream teardown', async () => {
    let releaseBlocked!: () => void;
    const blocked = new Promise<void>((resolve) => {
      releaseBlocked = resolve;
    });
    let blockedQueryStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      blockedQueryStarted = resolve;
    });
    let call = 0;
    const findMany = vi.fn(async () => {
      call += 1;
      if (call === 2) {
        blockedQueryStarted();
        await blocked;
      }
      return [];
    });
    const prisma = {
      taskTransition: { findFirst: vi.fn(), findMany },
    } as unknown as PrismaClient;
    const notifications = new Subject<TransitionNotification>();
    const subscription = new PrismaTaskEventStream(prisma, notifications)
      .stream({ taskId: TASK_ID })
      .subscribe();
    await vi.waitFor(() => {
      expect(findMany).toHaveBeenCalledTimes(1);
    });

    const notification = {
      transitionId: TRANSITION_A,
      taskId: TASK_ID,
      taskVersion: 3,
      status: 'RUNNING' as const,
      occurredAt: '2026-08-31T08:00:00.000Z',
    };
    notifications.next(notification);
    await started;
    for (let index = 0; index < 25; index += 1) notifications.next(notification);
    subscription.unsubscribe();
    releaseBlocked();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('rejects a cursor whose durable transition does not match the task and version', async () => {
    const findMany = vi.fn(async () => []);
    const prisma = {
      taskTransition: { findFirst: vi.fn(async () => null), findMany },
    } as unknown as PrismaClient;
    const stream = new PrismaTaskEventStream(prisma, new Subject<TransitionNotification>());

    await expect(
      firstValueFrom(
        stream.stream({
          taskId: TASK_ID,
          after: { taskVersion: 2, transitionId: TRANSITION_A },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    expect(findMany).not.toHaveBeenCalled();
  });
});
