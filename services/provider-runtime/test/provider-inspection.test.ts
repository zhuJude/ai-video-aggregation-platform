import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { inspectExecution } from '../src/runtime/production-composition.js';

const identity = {
  taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
  providerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7',
  executionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
  providerTaskId: 'remote-1',
  routeEpoch: 0,
} as const;

describe('provider inspection durable proof truth table', () => {
  it.each([
    {
      status: 'RUNNING',
      attempts: [{ status: 'ACCEPTED', providerTaskId: 'remote-1' }],
      expectedState: 'RUNNING',
      expectedAcceptance: 'ACCEPTED',
    },
    {
      status: 'FAILED',
      attempts: [{ status: 'FAILED', providerTaskId: 'remote-1' }],
      expectedState: 'FAILED',
      expectedAcceptance: 'UNKNOWN',
    },
    {
      status: 'CANCELED',
      attempts: [],
      expectedState: 'CANCELED',
      expectedAcceptance: 'UNKNOWN',
    },
    {
      status: 'ACCEPTED',
      attempts: [{ status: 'ACCEPTED', providerTaskId: 'different-task' }],
      expectedState: 'ACCEPTED',
      expectedAcceptance: 'UNKNOWN',
    },
    {
      status: 'AMBIGUOUS',
      attempts: [{ status: 'AMBIGUOUS', providerTaskId: 'remote-1' }],
      expectedState: 'AMBIGUOUS',
      expectedAcceptance: 'UNKNOWN',
    },
  ])(
    'derives only provable facts for $status',
    async ({ status, attempts, expectedState, expectedAcceptance }) => {
      const findFirst = vi.fn().mockResolvedValue({
        id: identity.executionId,
        taskId: identity.taskId,
        providerId: identity.providerId,
        providerTaskId: identity.providerTaskId,
        routeEpoch: identity.routeEpoch,
        status,
        attempts,
      });

      const result = await inspectExecution(
        { providerExecution: { findFirst } } as unknown as PrismaClient,
        identity,
      );

      expect(result).toMatchObject({
        state: expectedState,
        acceptance: expectedAcceptance,
        billing: 'UNKNOWN',
      });
      expect(JSON.stringify(result)).not.toMatch(/UNACCEPTED|UNBILLED|BILLED/);
    },
  );
});
