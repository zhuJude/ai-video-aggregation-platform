/* eslint-disable @typescript-eslint/require-await */
import { createHash } from 'node:crypto';
import type { VideoProviderAdapter } from '@repo/provider-sdk';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderExecutionService,
  type BeginExecutionInput,
  type BeginExecutionResult,
  type ClaimRetryResult,
  type CompleteExecutionInput,
  type ExecutionRepository,
} from '../src/index.js';

const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const CAPABILITY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a5';
const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7';
const NOW = new Date('2026-08-31T12:00:00.000Z');
const PARAMETERS = { prompt: 'hello' };
const HASH = createHash('sha256').update('{"prompt":"hello"}').digest('hex');

function event() {
  return {
    id: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a6',
    type: 'generation.task-queued.v1',
    version: 1,
    occurredAt: NOW.toISOString(),
    traceId: '0123456789abcdef0123456789abcdef',
    correlationId: TASK_ID,
    causationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
    producer: 'generation-service',
    data: {
      taskId: TASK_ID,
      userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
      quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
      capabilityVersionId: CAPABILITY_ID,
      status: 'QUEUED',
      taskVersion: 1,
      quotedPoints: '10',
      parametersSnapshotSha256: HASH,
    },
  };
}

class Repo implements ExecutionRepository {
  completion?: CompleteExecutionInput;
  async preflightQueued(): Promise<'CONTINUE'> {
    return 'CONTINUE';
  }
  async begin(input: BeginExecutionInput): Promise<BeginExecutionResult> {
    return {
      kind: 'STARTED',
      executionId: input.executionId,
      attemptId: input.attemptId,
      attemptNumber: 1,
      leaseToken: input.leaseToken,
    };
  }
  async claimRetry(): Promise<ClaimRetryResult> {
    return { kind: 'DUPLICATE_COMPLETE' };
  }
  async complete(input: CompleteExecutionInput): Promise<void> {
    this.completion = input;
  }
  async recordCommitAmbiguity(): Promise<void> {}
  async recordLateResult(): Promise<boolean> {
    return false;
  }
}

function adapter(): VideoProviderAdapter {
  return {
    code: 'mock',
    validateConfiguration: vi.fn(),
    getHealth: vi.fn(),
    createTask: vi.fn().mockResolvedValue({ providerTaskId: 'remote-1', state: 'ACCEPTED' }),
    queryTask: vi.fn(),
    verifyCallback: vi.fn(),
    normalizeCallback: vi.fn(),
  };
}

function service(callbackMode: 'EXPECTED' | 'UNAVAILABLE', repository = new Repo()) {
  let index = 0;
  const ids = [
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2',
    '0198f4d4-21c2-7b7d-8a03-08a0da2a51b3',
  ];
  return {
    repository,
    service: new ProviderExecutionService({
      repository,
      circuit: {
        acquire: vi.fn().mockResolvedValue({ kind: 'ALLOW', token: 'permit-1' }),
        record: vi.fn().mockResolvedValue(undefined),
        tripImmediately: vi.fn().mockResolvedValue(undefined),
      },
      resolver: {
        resolve: vi.fn().mockResolvedValue({
          taskId: TASK_ID,
          capabilityVersionId: CAPABILITY_ID,
          parametersSnapshotSha256: HASH,
          providerId: PROVIDER_ID,
          modelCode: 'internal-model-v1',
          parameters: PARAMETERS,
          adapter: adapter(),
          callbackMode,
          callbackDeadlineMs: 120_000,
          pollIntervalMs: 5_000,
        }),
      },
      clock: { now: () => NOW },
      ids: { next: () => ids[index++] ?? '0198f4d4-21c2-7b7d-8a03-08a0da2a51b3' },
    }),
  };
}

describe('initial durable polling schedule', () => {
  it('polls immediately on the configured interval when callbacks are unavailable', async () => {
    const { repository, service: runtime } = service('UNAVAILABLE');
    await runtime.handle(event());
    expect(repository.completion).toMatchObject({
      nextAction: 'POLL',
      pollSchedule: {
        callbackExpected: false,
        nextPollAt: new Date(NOW.getTime() + 5_000),
        outbox: {
          eventType: 'provider.execution-poll-due.v1',
          availableAt: new Date(NOW.getTime() + 5_000),
          payload: { attemptNumber: 1, pollNumber: 1 },
        },
      },
    });
  });

  it('uses the callback deadline as the first safety poll when callbacks are expected', async () => {
    const { repository, service: runtime } = service('EXPECTED');
    await runtime.handle(event());
    expect(repository.completion?.pollSchedule).toMatchObject({
      callbackExpected: true,
      callbackDeadlineAt: new Date(NOW.getTime() + 120_000),
      nextPollAt: new Date(NOW.getTime() + 120_000),
      outbox: { availableAt: new Date(NOW.getTime() + 120_000) },
    });
  });
});
