import type { TaskStatusSchema } from '@repo/contracts/generation';

export type TaskStatus = (typeof TaskStatusSchema.options)[number];

const allowedTransitions: Record<TaskStatus, readonly TaskStatus[]> = {
  QUOTED: ['RESERVED'],
  RESERVED: ['QUEUED', 'REFUNDED'],
  QUEUED: ['SUBMITTING', 'CANCELED', 'EXPIRED'],
  SUBMITTING: ['RUNNING', 'FAILED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'],
  SUCCEEDED: ['SETTLED'],
  FAILED: ['REFUNDED'],
  CANCELED: ['REFUNDED', 'SETTLED'],
  EXPIRED: ['REFUNDED'],
  SETTLED: [],
  REFUNDED: [],
};

export function transition(current: TaskStatus, next: TaskStatus): TaskStatus {
  if (!allowedTransitions[current].includes(next)) {
    throw Object.assign(new Error('ILLEGAL_TASK_TRANSITION'), {
      code: 'ILLEGAL_TASK_TRANSITION' as const,
      current,
      next,
    });
  }

  return next;
}
