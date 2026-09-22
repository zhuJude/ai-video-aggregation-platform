import { from, Observable, type ObservableInput } from 'rxjs';
import type {
  TaskEventStreamPort,
  TaskTransitionEvent,
} from '../application/task-events.service.js';
import { GenerationApplicationError } from '../application/errors.js';
import type { PrismaClient } from '../generated/prisma/client.js';

export type TransitionNotification = TaskTransitionEvent;

export class PrismaTaskEventStream implements TaskEventStreamPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly notifications: ObservableInput<TransitionNotification>,
    private readonly pollIntervalMs = 1_000,
  ) {}

  stream(input: {
    readonly taskId: string;
    readonly after?: { readonly taskVersion: number; readonly transitionId: string };
  }): Observable<TaskTransitionEvent> {
    return new Observable((subscriber) => {
      let highWaterVersion = input.after?.taskVersion ?? -1;
      let active = true;
      let ready = false;
      let dirty = true;
      let draining = false;
      let sourceCompleted = false;
      const isInactive = (): boolean => !active || subscriber.closed;

      const catchUp = async (): Promise<void> => {
        if (isInactive()) return;
        const rows = await this.prisma.taskTransition.findMany({
          where: {
            taskId: input.taskId,
            taskVersion: { gt: highWaterVersion },
          },
          orderBy: [{ taskVersion: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            taskId: true,
            taskVersion: true,
            toStatus: true,
            createdAt: true,
          },
        });
        rows.sort((left, right) => {
          const byVersion = left.taskVersion - right.taskVersion;
          return byVersion === 0 ? left.id.localeCompare(right.id) : byVersion;
        });
        for (const row of rows) {
          if (isInactive()) return;
          if (row.taskVersion <= highWaterVersion) continue;
          highWaterVersion = row.taskVersion;
          subscriber.next({
            transitionId: row.id,
            taskId: row.taskId,
            taskVersion: row.taskVersion,
            status: row.toStatus,
            occurredAt: row.createdAt.toISOString(),
          });
        }
      };

      const fail = (error: unknown): void => {
        if (!isInactive()) subscriber.error(error);
      };

      const drain = async (): Promise<void> => {
        if (draining || !ready || isInactive()) return;
        draining = true;
        try {
          while (!isInactive() && dirty) {
            dirty = false;
            await catchUp();
          }
          if (sourceCompleted && !dirty && !isInactive()) {
            subscriber.complete();
          }
        } catch (error) {
          fail(error);
        } finally {
          draining = false;
          if (dirty && !isInactive()) void drain();
        }
      };

      const wake = (): void => {
        dirty = true;
        if (ready) void drain();
      };

      // Notifications reduce latency, while the bounded durable poll makes an
      // active stream correct across replicas and after a lost notification.
      const pollTimer = setInterval(wake, this.pollIntervalMs);

      const live = from(this.notifications).subscribe({
        next: (event) => {
          if (event.taskId !== input.taskId) return;
          wake();
        },
        error: fail,
        complete: () => {
          sourceCompleted = true;
          wake();
        },
      });

      const initialize = async (): Promise<void> => {
        if (input.after !== undefined) {
          if (isInactive()) return;
          const cursor = await this.prisma.taskTransition.findFirst({
            where: {
              id: input.after.transitionId,
              taskId: input.taskId,
              taskVersion: input.after.taskVersion,
            },
            select: { id: true },
          });
          if (cursor === null) throw new GenerationApplicationError('INVALID_CURSOR');
        }
        if (isInactive()) return;
        ready = true;
        await drain();
      };

      void initialize().catch(fail);

      return () => {
        active = false;
        clearInterval(pollTimer);
        live.unsubscribe();
      };
    });
  }
}
