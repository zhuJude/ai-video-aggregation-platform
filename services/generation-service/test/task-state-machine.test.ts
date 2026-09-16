import { describe, expect, it } from 'vitest';
import { TaskStatusSchema } from '@repo/contracts/generation';
import { transition, type TaskStatus } from '../src/domain/task-state-machine.js';

const statuses = TaskStatusSchema.options;

const expectedTransitions = {
  QUOTED: ['RESERVED'],
  RESERVED: ['QUEUED', 'REFUNDED'],
  QUEUED: ['SUBMITTING', 'CANCELED', 'EXPIRED'],
  SUBMITTING: ['QUEUED', 'RUNNING', 'FAILED'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED'],
  SUCCEEDED: ['SETTLED'],
  FAILED: ['REFUNDED'],
  CANCELED: ['REFUNDED', 'SETTLED'],
  EXPIRED: ['REFUNDED'],
  SETTLED: [],
  REFUNDED: [],
} as const satisfies Record<TaskStatus, readonly TaskStatus[]>;

describe('task state machine', () => {
  it('covers every status in the frozen generation contract', () => {
    expect(Object.keys(expectedTransitions)).toEqual(statuses);
  });

  it('permits the success path from running through settlement', () => {
    expect(transition('RUNNING', 'SUCCEEDED')).toBe('SUCCEEDED');
    expect(transition('SUCCEEDED', 'SETTLED')).toBe('SETTLED');
  });

  it('permits every transition in the explicit transition table', () => {
    for (const current of statuses) {
      for (const next of expectedTransitions[current]) {
        expect(transition(current, next)).toBe(next);
      }
    }
  });

  it('rejects every transition absent from the explicit transition table', () => {
    for (const current of statuses) {
      for (const next of statuses) {
        if (!expectedTransitions[current].some((allowed) => allowed === next)) {
          expect(() => transition(current, next)).toThrow('ILLEGAL_TASK_TRANSITION');
        }
      }
    }
  });

  it('rejects a terminal regression with transition metadata', () => {
    expect.assertions(5);

    try {
      transition('SETTLED', 'RUNNING');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect(error).toMatchObject({
        message: 'ILLEGAL_TASK_TRANSITION',
        code: 'ILLEGAL_TASK_TRANSITION',
        current: 'SETTLED',
        next: 'RUNNING',
      });
      expect((error as { code: string }).code).toBe('ILLEGAL_TASK_TRANSITION');
      expect((error as { current: TaskStatus }).current).toBe('SETTLED');
      expect((error as { next: TaskStatus }).next).toBe('RUNNING');
    }
  });
});
