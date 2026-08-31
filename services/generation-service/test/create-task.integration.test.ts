/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method, @typescript-eslint/no-unsafe-assignment */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { UuidSchema, type EventEnvelope } from '@repo/contracts/common';
import type { TaskStatus } from '../src/domain/task-state-machine.js';
import {
  CreateTaskService,
  type CreateTaskPersistence,
  type IdempotencyClaim,
  type IdempotencyRecord,
  type PersistTaskInput,
  type RepairRequiredInput,
  type TaskCreationPhase,
  type TaskCreationRepository,
} from '../src/application/create-task.service.js';
import type {
  Clock,
  IdGenerator,
  QuoteRoute,
  RoutingQuotePort,
  WalletLedgerPort,
} from '../src/application/ports.js';
import { canonicalJson } from '../src/domain/canonical-json.js';
import { UuidV7Generator } from '../src/domain/uuid-v7.js';

const USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const OTHER_USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a9';
const QUOTE_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3';
const CAPABILITY_VERSION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4';
const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const IDEMPOTENCY_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';
const RESERVED_TRANSITION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2';
const QUEUED_TRANSITION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b3';
const OUTBOX_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b4';
const INITIAL_LEASE_TOKEN = 'a'.repeat(64);
const RECLAIM_A_LEASE_TOKEN = 'b'.repeat(64);
const RECLAIM_B_LEASE_TOKEN = 'c'.repeat(64);
const NOW = new Date('2026-08-31T08:00:00.000Z');

const command = {
  userId: USER_ID,
  quoteId: QUOTE_ID,
  capabilityVersionId: CAPABILITY_VERSION_ID,
  parameters: { prompt: 'ocean at dusk', aspect: { height: 9, width: 16 } },
  quotedPoints: '1200',
};

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function route(overrides: Partial<QuoteRoute['quote']> = {}): QuoteRoute {
  return {
    quote: {
      id: QUOTE_ID,
      userId: USER_ID,
      candidateModelIds: [],
      capabilityVersionId: CAPABILITY_VERSION_ID,
      quotedPoints: '1200',
      pricingRuleVersion: 7,
      expiresAt: '2026-08-31T08:05:00.000Z',
      parametersHash: sha256(command.parameters),
      ...overrides,
    },
    capabilitySnapshot: {
      id: CAPABILITY_VERSION_ID,
      kind: 'TEXT_TO_VIDEO',
      version: 3,
    },
    pricingSnapshot: { quotedPoints: '1200', pricingRuleVersion: 7 },
  };
}

class SequenceIdGenerator implements IdGenerator {
  private index = 0;

  constructor(
    private readonly values: readonly string[] = [
      TASK_ID,
      IDEMPOTENCY_ID,
      RESERVED_TRANSITION_ID,
      QUEUED_TRANSITION_ID,
      OUTBOX_ID,
      '0198f4d4-21c2-7b7d-8a03-08a0da2a51b5',
      '0198f4d4-21c2-7b7d-8a03-08a0da2a51b6',
      '0198f4d4-21c2-7b7d-8a03-08a0da2a51b7',
      '0198f4d4-21c2-7b7d-8a03-08a0da2a51b8',
      ...Array.from(
        { length: 20 },
        (_, index) => `0198f4d4-21c2-7b7d-8a03-${(0x8b9 + index).toString(16).padStart(12, '0')}`,
      ),
    ],
  ) {}

  next(): string {
    const value = this.values[this.index];
    if (value === undefined) throw new Error('ID_SEQUENCE_EXHAUSTED');
    this.index += 1;
    return value;
  }
}

class SequenceLeaseTokenGenerator {
  private index = 0;

  constructor(
    private readonly values: readonly string[] = [
      INITIAL_LEASE_TOKEN,
      ...Array.from({ length: 20 }, (_, index) => (index + 16).toString(16).padStart(64, '0')),
    ],
  ) {}

  next(): string {
    const value = this.values[this.index];
    if (value === undefined) throw new Error('LEASE_TOKEN_SEQUENCE_EXHAUSTED');
    this.index += 1;
    return value;
  }
}

class MemoryTaskCreationRepository implements TaskCreationRepository {
  readonly idempotencies = new Map<string, IdempotencyRecord>();
  readonly tasks = new Map<string, PersistTaskInput>();
  readonly outbox = new Map<string, EventEnvelope>();
  readonly repairCases: RepairRequiredInput[] = [];
  persistenceFailures: Error[] = [];
  failedMarkFailures: Error[] = [];
  repairFailures: Error[] = [];
  phaseUpdateFailures: Error[] = [];
  throwAfterCommit: Error | undefined;
  failedMarks = 0;
  reclaimWinners = 0;
  reclaimAfterWrite: (() => Promise<void>) | undefined;
  beginReservationThrowAfterCommit = false;
  beginReservationLeaseTokenAfterCommit: string | undefined;

  async claimIdempotency(claim: IdempotencyClaim): Promise<IdempotencyRecord> {
    const key = `${claim.userId}:${claim.idempotencyKey}`;
    const existing = this.idempotencies.get(key);
    if (existing !== undefined) return existing;

    const record: IdempotencyRecord = {
      ...claim,
      status: 'IN_PROGRESS',
      taskId: null,
      response: null,
    };
    this.idempotencies.set(key, record);
    return record;
  }

  async getIdempotency(userId: string, idempotencyKey: string): Promise<IdempotencyRecord | null> {
    return this.idempotencies.get(`${userId}:${idempotencyKey}`) ?? null;
  }

  async tryReclaimIdempotency(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly now: Date;
    readonly expiresAt: Date;
    readonly expectedLeaseToken: string;
    readonly newLeaseToken: string;
  }): Promise<boolean> {
    const key = `${input.userId}:${input.idempotencyKey}`;
    const record = this.idempotencies.get(key);
    if (
      record === undefined ||
      record.status !== 'IN_PROGRESS' ||
      record.phase !== 'CLAIMED' ||
      record.requestSha256 !== input.requestSha256 ||
      record.leaseToken !== input.expectedLeaseToken ||
      record.expiresAt.getTime() > input.now.getTime()
    ) {
      return false;
    }
    const reclaimed = {
      ...record,
      expiresAt: input.expiresAt,
      leaseToken: input.newLeaseToken,
    };
    this.idempotencies.set(key, reclaimed);
    this.reclaimWinners += 1;
    await this.reclaimAfterWrite?.();
    return true;
  }

  async persistTask(input: PersistTaskInput): Promise<CreateTaskPersistence> {
    const failure = this.persistenceFailures.shift();
    if (failure !== undefined) throw failure;

    const key = `${input.userId}:${input.idempotencyKey}`;
    const record = this.idempotencies.get(key);
    if (
      record?.status !== 'IN_PROGRESS' ||
      record.phase !== 'RESERVED' ||
      record.requestSha256 !== input.requestSha256 ||
      record.leaseToken !== input.leaseToken
    ) {
      throw new Error('IDEMPOTENCY_NOT_OWNED');
    }

    this.tasks.set(input.taskId, structuredClone(input));
    this.outbox.set(input.event.id, structuredClone(input.event));
    const response: CreateTaskPersistence = {
      taskId: input.taskId,
      status: 'QUEUED',
      version: 2,
    };
    this.idempotencies.set(key, {
      ...record,
      status: 'SUCCEEDED',
      phase: 'SUCCEEDED',
      taskId: input.taskId,
      response,
    });
    const ambiguousCommit = this.throwAfterCommit;
    this.throwAfterCommit = undefined;
    if (ambiguousCommit !== undefined) throw ambiguousCommit;
    return response;
  }

  async markIdempotencyFailed(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly leaseToken: string;
    readonly expectedPhase: TaskCreationPhase;
    readonly expectedExpiresAt: Date;
    readonly now: Date;
    readonly errorCode: string;
  }): Promise<boolean> {
    const failure = this.failedMarkFailures.shift();
    if (failure !== undefined) throw failure;
    const key = `${input.userId}:${input.idempotencyKey}`;
    const record = this.idempotencies.get(key);
    if (
      record === undefined ||
      record.status !== 'IN_PROGRESS' ||
      record.requestSha256 !== input.requestSha256 ||
      record.leaseToken !== input.leaseToken ||
      record.phase !== input.expectedPhase ||
      (input.expectedPhase === 'CLAIMED' &&
        (record.expiresAt.getTime() !== input.expectedExpiresAt.getTime() ||
          record.expiresAt.getTime() <= input.now.getTime()))
    ) {
      return false;
    }
    this.failedMarks += 1;
    this.idempotencies.set(key, {
      ...record,
      status: 'FAILED',
      phase: 'FAILED',
      response: { errorCode: input.errorCode },
    });
    return true;
  }

  async updateIdempotencyPhase(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly leaseToken: string;
    readonly expectedPhase: TaskCreationPhase;
    readonly nextPhase: TaskCreationPhase;
  }): Promise<boolean> {
    const failure = this.phaseUpdateFailures.shift();
    if (failure !== undefined) throw failure;
    const key = `${input.userId}:${input.idempotencyKey}`;
    const record = this.idempotencies.get(key);
    if (
      record === undefined ||
      record.status !== 'IN_PROGRESS' ||
      record.requestSha256 !== input.requestSha256 ||
      record.leaseToken !== input.leaseToken ||
      record.phase !== input.expectedPhase
    ) {
      return false;
    }
    this.idempotencies.set(key, { ...record, phase: input.nextPhase });
    return true;
  }

  async tryBeginReservation(input: {
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly requestSha256: string;
    readonly leaseToken: string;
    readonly expectedExpiresAt: Date;
    readonly now: Date;
  }): Promise<boolean> {
    const key = `${input.userId}:${input.idempotencyKey}`;
    const record = this.idempotencies.get(key);
    if (
      record === undefined ||
      record.status !== 'IN_PROGRESS' ||
      record.phase !== 'CLAIMED' ||
      record.requestSha256 !== input.requestSha256 ||
      record.leaseToken !== input.leaseToken ||
      record.expiresAt.getTime() !== input.expectedExpiresAt.getTime() ||
      record.expiresAt.getTime() <= input.now.getTime()
    ) {
      return false;
    }
    const reserved = { ...record, phase: 'RESERVE_REQUESTED' as const };
    this.idempotencies.set(key, reserved);
    if (this.beginReservationLeaseTokenAfterCommit !== undefined) {
      this.idempotencies.set(key, {
        ...reserved,
        leaseToken: this.beginReservationLeaseTokenAfterCommit,
      });
    }
    if (this.beginReservationThrowAfterCommit) {
      this.beginReservationThrowAfterCommit = false;
      throw new Error('connection lost after commit');
    }
    return true;
  }

  async recordRepairRequired(input: RepairRequiredInput): Promise<boolean> {
    const failure = this.repairFailures.shift();
    if (failure !== undefined) throw failure;
    const key = `${input.userId}:${input.idempotencyKey}`;
    const record = this.idempotencies.get(key);
    if (
      record === undefined ||
      record.status !== 'IN_PROGRESS' ||
      record.requestSha256 !== input.requestSha256 ||
      record.leaseToken !== input.leaseToken ||
      record.phase !== input.phase
    ) {
      return false;
    }
    this.idempotencies.set(key, {
      ...record,
      status: 'FAILED',
      phase: 'REPAIR_REQUIRED',
      response: { errorCode: 'TASK_CREATION_REPAIR_REQUIRED' },
    });
    this.repairCases.push(structuredClone(input));
    return true;
  }
}

function harness(
  options: {
    readonly quote?: QuoteRoute;
    readonly repository?: MemoryTaskCreationRepository;
    readonly routingError?: Error;
    readonly reserveError?: Error;
    readonly releaseError?: Error;
    readonly ids?: IdGenerator;
    readonly clock?: Clock;
    readonly routing?: RoutingQuotePort;
    readonly wallet?: WalletLedgerPort;
    readonly leaseTokens?: SequenceLeaseTokenGenerator;
    readonly idempotencyTtlMs?: number;
  } = {},
) {
  const repository = options.repository ?? new MemoryTaskCreationRepository();
  const routing: RoutingQuotePort = options.routing ?? {
    getQuote: vi.fn(async () => {
      if (options.routingError !== undefined) throw options.routingError;
      return options.quote ?? route();
    }),
  };
  const wallet: WalletLedgerPort = options.wallet ?? {
    reserve: vi.fn(async () => {
      if (options.reserveError !== undefined) throw options.reserveError;
    }),
    release: vi.fn(async () => {
      if (options.releaseError !== undefined) throw options.releaseError;
    }),
  };
  const clock = options.clock ?? { now: () => new Date(NOW) };
  const service = new CreateTaskService({
    repository,
    routing,
    wallet,
    ids: options.ids ?? new SequenceIdGenerator(),
    leaseTokens: options.leaseTokens ?? new SequenceLeaseTokenGenerator(),
    clock,
    sleep: async () => Promise.resolve(),
    maxPersistenceAttempts: 3,
    contenderMaxAttempts: 10,
    ...(options.idempotencyTtlMs === undefined
      ? {}
      : { idempotencyTtlMs: options.idempotencyTtlMs }),
  });

  return { repository, routing, service, wallet };
}

describe('CreateTaskService integration', () => {
  it('uses contract-compatible UUIDv7 identifiers in production', () => {
    expect(UuidSchema.safeParse(new UuidV7Generator().next()).success).toBe(true);
  });

  it('elects one winner for concurrent identical idempotency requests', async () => {
    const { repository, service, wallet } = harness();

    const [first, second] = await Promise.all([
      service.execute(command, 'idem-1'),
      service.execute(command, 'idem-1'),
    ]);

    expect(second.taskId).toBe(first.taskId);
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.reserve).toHaveBeenCalledWith({
      businessKey: `task:${first.taskId}:reserve`,
      userId: USER_ID,
      kind: 'RESERVE',
      points: '1200',
      reason: 'GENERATION_TASK_CREATE',
    });
    expect(repository.tasks.size).toBe(1);
    expect(repository.outbox.size).toBe(1);
  });

  it('rejects a different fingerprint reusing the same idempotency key', async () => {
    const { service, wallet } = harness();
    await service.execute(command, 'idem-1');

    await expect(
      service.execute({ ...command, quotedPoints: '1201' }, 'idem-1'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT', retryable: false });
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
  });

  it('uses key-order-independent canonical JSON for parameters and request fingerprints', async () => {
    const { service, wallet } = harness();
    const reordered = {
      ...command,
      parameters: { aspect: { width: 16, height: 9 }, prompt: 'ocean at dusk' },
    };

    const first = await service.execute(command, 'idem-1');
    const second = await service.execute(reordered, 'idem-1');

    expect(second).toEqual(first);
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
  });

  it('preserves an own __proto__ parameter key in quote and idempotency fingerprints', async () => {
    const parameters = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(parameters, '__proto__', {
      configurable: true,
      enumerable: true,
      value: { mode: 'strict' },
      writable: true,
    });
    const specialCommand = { ...command, parameters };
    const { service, wallet } = harness({
      quote: route({ parametersHash: sha256(parameters) }),
    });

    await expect(service.execute(specialCommand, 'idem-proto')).resolves.toMatchObject({
      status: 'QUEUED',
    });
    await expect(
      service.execute({ ...command, parameters: {} }, 'idem-proto'),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['BigInt', { nested: 1n }],
    [
      'custom prototype',
      Object.assign(
        new (class Parameters {
          readonly marker = true;
        })(),
        { prompt: 'custom' },
      ),
    ],
    ['toJSON', { toJSON: () => ({ prompt: 'disguised' }) }],
  ])(
    'rejects non-JSON command parameters containing %s before wallet effects',
    async (_label, parameters) => {
      const { service, wallet } = harness();

      await expect(
        service.execute({ ...command, parameters }, 'idem-invalid'),
      ).rejects.toMatchObject({
        code: 'INVALID_TASK_REQUEST',
      });
      expect(wallet.reserve).not.toHaveBeenCalled();
      expect(wallet.release).not.toHaveBeenCalled();
    },
  );

  it('rejects cyclic command parameters before wallet effects', async () => {
    const parameters: Record<string, unknown> = {};
    parameters.self = parameters;
    const { service, wallet } = harness();

    await expect(service.execute({ ...command, parameters }, 'idem-cycle')).rejects.toMatchObject({
      code: 'INVALID_TASK_REQUEST',
    });
    expect(wallet.reserve).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('rejects command accessors without invoking them or calling wallet', async () => {
    const getter = vi.fn(() => 'secret');
    const parameters = Object.defineProperty({}, 'prompt', { enumerable: true, get: getter });
    const { service, wallet } = harness();

    await expect(service.execute({ ...command, parameters }, 'idem-getter')).rejects.toMatchObject({
      code: 'INVALID_TASK_REQUEST',
    });
    expect(getter).not.toHaveBeenCalled();
    expect(wallet.reserve).not.toHaveBeenCalled();
  });

  it('strictly prepares routing snapshots before entering the wallet phase', async () => {
    const validRoute = route();
    const invalidRoute: QuoteRoute = {
      ...validRoute,
      capabilitySnapshot: { id: CAPABILITY_VERSION_ID, unsupported: 1n },
    };
    const { service, wallet } = harness({ quote: invalidRoute });

    await expect(service.execute(command, 'idem-route-json')).rejects.toMatchObject({
      code: 'QUOTE_MISMATCH',
    });
    expect(wallet.reserve).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it.each([
    ['user', { userId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a9' }],
    ['capability', { capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a9' }],
    ['points', { quotedPoints: '1201' }],
    ['parameters', { parametersHash: '0'.repeat(64) }],
  ])('rejects a quote with mismatched %s', async (_name, quoteOverride) => {
    const { repository, service, wallet } = harness({ quote: route(quoteOverride) });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'QUOTE_MISMATCH',
      retryable: false,
    });
    expect(wallet.reserve).not.toHaveBeenCalled();
    expect(repository.failedMarks).toBe(1);
  });

  it('rejects an expired quote without reserving points', async () => {
    const { service, wallet } = harness({
      quote: route({ expiresAt: NOW.toISOString() }),
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'QUOTE_EXPIRED',
      retryable: false,
    });
    expect(wallet.reserve).not.toHaveBeenCalled();
  });

  it.each([
    ['capability', { capabilitySnapshot: { id: OTHER_USER_ID } }],
    ['pricing', { pricingSnapshot: { quotedPoints: '1201', pricingRuleVersion: 7 } }],
  ])('rejects an inconsistent %s snapshot', async (_name, routeOverride) => {
    const { service, wallet } = harness({ quote: { ...route(), ...routeOverride } });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'QUOTE_MISMATCH',
    });
    expect(wallet.reserve).not.toHaveBeenCalled();
  });

  it('does not disguise a routing outage as a missing quote', async () => {
    const { repository, service, wallet } = harness({
      routingError: new Error('routing timeout'),
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'ROUTING_UNAVAILABLE',
      retryable: true,
    });
    expect(repository.failedMarks).toBe(1);
    expect(wallet.reserve).not.toHaveBeenCalled();
  });

  it('returns the same pending result when quote-failure finalization is unavailable', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.failedMarkFailures = Array.from({ length: 3 }, () => new Error('db unavailable'));
    const { service, wallet } = harness({
      repository,
      quote: route({ quotedPoints: '1201' }),
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryable: true,
    });
    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryable: true,
    });
    expect(wallet.reserve).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('reclaims an expired safe claim while preserving its planned wallet operation', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.idempotencies.set(`${USER_ID}:idem-1`, {
      id: IDEMPOTENCY_ID,
      userId: USER_ID,
      idempotencyKey: 'idem-1',
      requestSha256: sha256(command),
      proposedTaskId: TASK_ID,
      quotedPoints: '1200',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
      traceId: 'a'.repeat(32),
      leaseToken: INITIAL_LEASE_TOKEN,
      phase: 'CLAIMED',
      status: 'IN_PROGRESS',
      taskId: null,
      response: null,
      createdAt: new Date('2026-08-30T08:00:00.000Z'),
      expiresAt: new Date('2026-08-31T07:59:59.000Z'),
    });
    const { service, wallet } = harness({
      repository,
      ids: new SequenceIdGenerator([
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
        RESERVED_TRANSITION_ID,
        QUEUED_TRANSITION_ID,
        OUTBOX_ID,
      ]),
    });

    await expect(service.execute(command, 'idem-1')).resolves.toEqual({
      taskId: TASK_ID,
      status: 'QUEUED',
      version: 2,
    });
    expect(repository.reclaimWinners).toBe(1);
    expect(wallet.reserve).toHaveBeenCalledOnce();
    expect(wallet.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ businessKey: `task:${TASK_ID}:reserve` }),
    );
    expect(repository.tasks.size).toBe(1);
    expect(repository.outbox.size).toBe(1);
  });

  it('does not reclaim an expired claim after a possible wallet effect', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.idempotencies.set(`${USER_ID}:idem-1`, {
      id: IDEMPOTENCY_ID,
      userId: USER_ID,
      idempotencyKey: 'idem-1',
      requestSha256: sha256(command),
      proposedTaskId: TASK_ID,
      quotedPoints: '1200',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
      traceId: 'a'.repeat(32),
      leaseToken: INITIAL_LEASE_TOKEN,
      phase: 'RESERVE_REQUESTED',
      status: 'IN_PROGRESS',
      taskId: null,
      response: null,
      createdAt: new Date('2026-08-30T08:00:00.000Z'),
      expiresAt: new Date('2026-08-31T07:59:59.000Z'),
    });
    const { service, wallet } = harness({
      repository,
      ids: new SequenceIdGenerator([
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c2',
      ]),
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'TASK_CREATION_REPAIR_REQUIRED',
      retryable: false,
    });
    expect(repository.reclaimWinners).toBe(0);
    expect(wallet.reserve).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.repairCases).toHaveLength(1);
  });

  it('elects one winner when concurrent callers reclaim an expired safe claim', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.idempotencies.set(`${USER_ID}:idem-1`, {
      id: IDEMPOTENCY_ID,
      userId: USER_ID,
      idempotencyKey: 'idem-1',
      requestSha256: sha256(command),
      proposedTaskId: TASK_ID,
      quotedPoints: '1200',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
      traceId: 'a'.repeat(32),
      leaseToken: INITIAL_LEASE_TOKEN,
      phase: 'CLAIMED',
      status: 'IN_PROGRESS',
      taskId: null,
      response: null,
      createdAt: new Date('2026-08-30T08:00:00.000Z'),
      expiresAt: new Date('2026-08-31T07:59:59.000Z'),
    });
    const { service, wallet } = harness({
      repository,
      ids: new SequenceIdGenerator([
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c2',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c3',
        RESERVED_TRANSITION_ID,
        QUEUED_TRANSITION_ID,
        OUTBOX_ID,
      ]),
    });

    const results = await Promise.all([
      service.execute(command, 'idem-1'),
      service.execute(command, 'idem-1'),
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(repository.reclaimWinners).toBe(1);
    expect(wallet.reserve).toHaveBeenCalledOnce();
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(1);
    expect(repository.outbox.size).toBe(1);
  });

  it('fences an expired original winner after another caller reclaims its lease', async () => {
    let now = new Date(NOW);
    let releaseOriginal: ((value: QuoteRoute) => void) | undefined;
    const clock: Clock = { now: () => new Date(now) };
    const repository = new MemoryTaskCreationRepository();
    const routing: RoutingQuotePort = {
      getQuote: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<QuoteRoute>((resolve) => {
              releaseOriginal = (value) => {
                resolve(value);
              };
            }),
        )
        .mockResolvedValue(route()),
    };
    const firstHarness = harness({ repository, routing, clock, idempotencyTtlMs: 1_000 });

    const original = firstHarness.service.execute(command, 'idem-1');
    await vi.waitFor(() => {
      expect(routing.getQuote).toHaveBeenCalledOnce();
    });
    now = new Date(NOW.getTime() + 1_001);
    const reclaimer = new CreateTaskService({
      repository,
      routing,
      wallet: firstHarness.wallet,
      ids: new SequenceIdGenerator([
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
        RESERVED_TRANSITION_ID,
        QUEUED_TRANSITION_ID,
        OUTBOX_ID,
      ]),
      clock,
      sleep: async () => Promise.resolve(),
      maxPersistenceAttempts: 3,
      contenderMaxAttempts: 10,
      idempotencyTtlMs: 1_000,
    });

    const reclaimedResult = await reclaimer.execute(command, 'idem-1');
    releaseOriginal?.(route());
    await expect(original).resolves.toEqual(reclaimedResult);
    expect(repository.reclaimWinners).toBe(1);
    expect(firstHarness.wallet.reserve).toHaveBeenCalledOnce();
    expect(firstHarness.wallet.release).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(1);
    expect(repository.outbox.size).toBe(1);
  });

  it('fences reclaimer A when reclaimer B replaces its expired token before acknowledgement', async () => {
    let now = new Date(NOW);
    let signalFirstWrite: (() => void) | undefined;
    let releaseFirstAcknowledgement: (() => void) | undefined;
    const firstWrite = new Promise<void>((resolve) => {
      signalFirstWrite = () => {
        resolve();
      };
    });
    const holdFirstAcknowledgement = new Promise<void>((resolve) => {
      releaseFirstAcknowledgement = () => {
        resolve();
      };
    });
    let reclaimCalls = 0;
    const repository = new MemoryTaskCreationRepository();
    repository.reclaimAfterWrite = async () => {
      reclaimCalls += 1;
      if (reclaimCalls === 1) {
        signalFirstWrite?.();
        await holdFirstAcknowledgement;
      }
    };
    repository.idempotencies.set(`${USER_ID}:idem-1`, {
      id: IDEMPOTENCY_ID,
      userId: USER_ID,
      idempotencyKey: 'idem-1',
      requestSha256: sha256(command),
      proposedTaskId: TASK_ID,
      quotedPoints: '1200',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
      traceId: 'a'.repeat(32),
      leaseToken: INITIAL_LEASE_TOKEN,
      phase: 'CLAIMED',
      status: 'IN_PROGRESS',
      taskId: null,
      response: null,
      createdAt: new Date('2026-08-30T08:00:00.000Z'),
      expiresAt: new Date('2026-08-31T07:59:59.000Z'),
    });
    const routeResolvers: Array<(value: QuoteRoute) => void> = [];
    const routing: RoutingQuotePort = {
      getQuote: vi.fn(
        () =>
          new Promise<QuoteRoute>((resolve) => {
            routeResolvers.push(resolve);
          }),
      ),
    };
    const wallet: WalletLedgerPort = {
      reserve: vi.fn(async () => Promise.resolve()),
      release: vi.fn(async () => Promise.resolve()),
    };
    const clock: Clock = { now: () => new Date(now) };
    const makeReclaimer = (ids: readonly string[], leaseToken: string) =>
      new CreateTaskService({
        repository,
        routing,
        wallet,
        ids: new SequenceIdGenerator(ids),
        leaseTokens: new SequenceLeaseTokenGenerator([leaseToken]),
        clock,
        sleep: async () => Promise.resolve(),
        contenderMaxAttempts: 10,
        idempotencyTtlMs: 1_000,
      });
    const reclaimerA = makeReclaimer(
      [
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c2',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c3',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c4',
      ],
      RECLAIM_A_LEASE_TOKEN,
    );
    const reclaimerB = makeReclaimer(
      [
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51d0',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51d1',
        RESERVED_TRANSITION_ID,
        QUEUED_TRANSITION_ID,
        OUTBOX_ID,
      ],
      RECLAIM_B_LEASE_TOKEN,
    );

    const resultA = reclaimerA.execute(command, 'idem-1');
    await firstWrite;
    now = new Date(NOW.getTime() + 1_001);
    const resultB = reclaimerB.execute(command, 'idem-1');
    await vi.waitFor(() => {
      expect(routeResolvers).toHaveLength(1);
    });
    releaseFirstAcknowledgement?.();
    await vi.waitFor(() => {
      expect(routeResolvers).toHaveLength(2);
    });
    for (const resolve of routeResolvers) resolve(route());

    const [settledA, settledB] = await Promise.all([resultA, resultB]);
    expect(settledA).toEqual(settledB);
    expect(repository.reclaimWinners).toBe(2);
    expect(wallet.reserve).toHaveBeenCalledOnce();
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(1);
    expect(repository.outbox.size).toBe(1);
  });

  it('prevents a stale route failure from failing a reclaimed owner', async () => {
    let now = new Date(NOW);
    let releaseOriginalRoute: ((value: QuoteRoute) => void) | undefined;
    let releaseReserve: (() => void) | undefined;
    const clock: Clock = { now: () => new Date(now) };
    const repository = new MemoryTaskCreationRepository();
    const routing: RoutingQuotePort = {
      getQuote: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<QuoteRoute>((resolve) => {
              releaseOriginalRoute = (value) => {
                resolve(value);
              };
            }),
        )
        .mockResolvedValue(route()),
    };
    const wallet: WalletLedgerPort = {
      reserve: vi.fn(
        () =>
          new Promise<void>((resolve) => {
            releaseReserve = () => {
              resolve();
            };
          }),
      ),
      release: vi.fn(async () => Promise.resolve()),
    };
    const originalHarness = harness({
      repository,
      routing,
      wallet,
      clock,
      leaseTokens: new SequenceLeaseTokenGenerator([INITIAL_LEASE_TOKEN]),
      idempotencyTtlMs: 1_000,
    });

    const original = originalHarness.service.execute(command, 'idem-1');
    await vi.waitFor(() => {
      expect(routing.getQuote).toHaveBeenCalledOnce();
    });
    now = new Date(NOW.getTime() + 1_001);
    const replacement = new CreateTaskService({
      repository,
      routing,
      wallet,
      ids: new SequenceIdGenerator([
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c0',
        '0198f4d4-21c2-7b7d-8a03-08a0da2a51c1',
        RESERVED_TRANSITION_ID,
        QUEUED_TRANSITION_ID,
        OUTBOX_ID,
      ]),
      leaseTokens: new SequenceLeaseTokenGenerator([RECLAIM_A_LEASE_TOKEN]),
      clock,
      sleep: async () => Promise.resolve(),
      contenderMaxAttempts: 2,
      idempotencyTtlMs: 1_000,
    });
    const replacementResult = replacement.execute(command, 'idem-1');
    await vi.waitFor(() => {
      expect(wallet.reserve).toHaveBeenCalledOnce();
    });

    releaseOriginalRoute?.(route({ quotedPoints: '1201' }));
    await expect(original).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryable: true,
    });
    expect(repository.idempotencies.get(`${USER_ID}:idem-1`)).toMatchObject({
      status: 'IN_PROGRESS',
      phase: 'RESERVE_REQUESTED',
      leaseToken: RECLAIM_A_LEASE_TOKEN,
    });

    releaseReserve?.();
    await expect(replacementResult).resolves.toMatchObject({ taskId: TASK_ID, status: 'QUEUED' });
    expect(wallet.reserve).toHaveBeenCalledOnce();
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(1);
    expect(repository.outbox.size).toBe(1);
  });

  it('prevents an expired claimed owner from finalizing a pre-reserve failure', async () => {
    let now = new Date(NOW);
    let releaseRoute: ((value: QuoteRoute) => void) | undefined;
    const clock: Clock = { now: () => new Date(now) };
    const repository = new MemoryTaskCreationRepository();
    const routing: RoutingQuotePort = {
      getQuote: vi.fn(
        () =>
          new Promise<QuoteRoute>((resolve) => {
            releaseRoute = (value) => {
              resolve(value);
            };
          }),
      ),
    };
    const { service, wallet } = harness({
      repository,
      routing,
      clock,
      leaseTokens: new SequenceLeaseTokenGenerator([INITIAL_LEASE_TOKEN]),
      idempotencyTtlMs: 1_000,
    });

    const result = service.execute(command, 'idem-1');
    await vi.waitFor(() => {
      expect(routing.getQuote).toHaveBeenCalledOnce();
    });
    now = new Date(NOW.getTime() + 1_001);
    releaseRoute?.(route({ quotedPoints: '1201' }));

    await expect(result).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryable: true,
    });
    expect(repository.idempotencies.get(`${USER_ID}:idem-1`)).toMatchObject({
      status: 'IN_PROGRESS',
      phase: 'CLAIMED',
      leaseToken: INITIAL_LEASE_TOKEN,
    });
    expect(wallet.reserve).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
  });

  it('accepts an ambiguous reservation-phase acknowledgement only for the same lease token', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.beginReservationThrowAfterCommit = true;
    const { service, wallet } = harness({
      repository,
      leaseTokens: new SequenceLeaseTokenGenerator([INITIAL_LEASE_TOKEN]),
    });

    await expect(service.execute(command, 'idem-1')).resolves.toMatchObject({
      taskId: TASK_ID,
      status: 'QUEUED',
    });
    expect(wallet.reserve).toHaveBeenCalledOnce();
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(1);
    expect(repository.outbox.size).toBe(1);
  });

  it('rejects an ambiguous reservation-phase acknowledgement owned by a different token', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.beginReservationThrowAfterCommit = true;
    repository.beginReservationLeaseTokenAfterCommit = RECLAIM_A_LEASE_TOKEN;
    const { service, wallet } = harness({
      repository,
      leaseTokens: new SequenceLeaseTokenGenerator([INITIAL_LEASE_TOKEN]),
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      retryable: true,
    });
    expect(wallet.reserve).not.toHaveBeenCalled();
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(0);
    expect(repository.outbox.size).toBe(0);
  });

  it('retries bounded transient persistence failures without duplicating finance or outbox effects', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.persistenceFailures = [
      Object.assign(new Error('serialization failure'), { transient: true }),
      Object.assign(new Error('deadlock'), { transient: true }),
    ];
    const persistSpy = vi.spyOn(repository, 'persistTask');
    const { service, wallet } = harness({ repository });

    const result = await service.execute(command, 'idem-1');

    expect(result.taskId).toBe(TASK_ID);
    expect(persistSpy).toHaveBeenCalledTimes(3);
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.outbox.size).toBe(1);
  });

  it('recovers an idempotency success after an ambiguous persistence acknowledgement', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.throwAfterCommit = Object.assign(new Error('connection lost after commit'), {
      transient: true,
    });
    const { service, wallet } = harness({ repository });

    await expect(service.execute(command, 'idem-1')).resolves.toMatchObject({
      status: 'QUEUED',
      version: 2,
    });
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(1);
    expect(repository.outbox.size).toBe(1);
  });

  it('compensates exactly once after bounded persistence exhaustion', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.persistenceFailures = Array.from({ length: 3 }, () =>
      Object.assign(new Error('serialization failure'), { transient: true }),
    );
    const { service, wallet } = harness({ repository });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'TASK_CREATION_FAILED',
      retryable: true,
    });
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.release).toHaveBeenCalledTimes(1);
    expect(wallet.release).toHaveBeenCalledWith({
      businessKey: `task:${TASK_ID}:create-compensation`,
      userId: USER_ID,
      kind: 'RELEASE',
      points: '1200',
      reason: 'GENERATION_TASK_CREATE_COMPENSATION',
    });
    expect(repository.failedMarks).toBe(1);
    expect(repository.tasks.size).toBe(0);
    expect(repository.outbox.size).toBe(0);
  });

  it('retries durable idempotency failure finalization without repeating compensation', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.persistenceFailures = Array.from({ length: 3 }, () =>
      Object.assign(new Error('serialization failure'), { transient: true }),
    );
    repository.failedMarkFailures = [new Error('db unavailable'), new Error('db unavailable')];
    const markSpy = vi.spyOn(repository, 'markIdempotencyFailed');
    const { service, wallet } = harness({ repository });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'TASK_CREATION_FAILED',
    });
    expect(wallet.release).toHaveBeenCalledTimes(1);
    expect(markSpy).toHaveBeenCalledTimes(3);
    expect(repository.failedMarks).toBe(1);
  });

  it('retains a compensated phase when failure finalization remains unavailable', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.persistenceFailures = Array.from({ length: 3 }, () =>
      Object.assign(new Error('serialization failure'), { transient: true }),
    );
    repository.failedMarkFailures = Array.from({ length: 3 }, () => new Error('db unavailable'));
    const { service, wallet } = harness({ repository });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'REPAIR_PERSISTENCE_UNAVAILABLE',
      retryable: true,
    });
    expect(repository.idempotencies.get(`${USER_ID}:idem-1`)).toMatchObject({
      status: 'IN_PROGRESS',
      phase: 'COMPENSATED',
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'TASK_CREATION_REPAIR_REQUIRED',
      retryable: false,
    });
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.release).toHaveBeenCalledTimes(1);
    expect(repository.repairCases).toHaveLength(1);
  });

  it('exposes repair-required when compensation is uncertain', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.persistenceFailures = [Object.assign(new Error('fatal'), { transient: false })];
    const { service, wallet } = harness({
      repository,
      releaseError: new Error('wallet timeout'),
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'TASK_CREATION_REPAIR_REQUIRED',
      retryable: false,
    });
    expect(wallet.release).toHaveBeenCalledTimes(1);
    expect(repository.repairCases).toHaveLength(1);
    expect(repository.repairCases[0]).toMatchObject({
      userId: USER_ID,
      idempotencyKey: 'idem-1',
      proposedTaskId: TASK_ID,
      quotedPoints: '1200',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
      phase: 'COMPENSATION_REQUESTED',
      errorCode: 'WALLET_COMPENSATION_UNCERTAIN',
    });
    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'TASK_CREATION_REPAIR_REQUIRED',
    });
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.release).toHaveBeenCalledTimes(1);
  });

  it('does not leave a reusable in-progress key when reservation is uncertain', async () => {
    const { repository, service, wallet } = harness({
      reserveError: new Error('wallet timeout'),
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'TASK_CREATION_REPAIR_REQUIRED',
      retryable: false,
    });
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.failedMarks).toBe(0);
    expect(repository.repairCases).toHaveLength(1);
  });

  it('returns stable persistence-unavailable when repair finalization cannot be stored', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.persistenceFailures = [Object.assign(new Error('fatal'), { transient: false })];
    repository.repairFailures = Array.from({ length: 3 }, () => new Error('db unavailable'));
    const { service, wallet } = harness({
      repository,
      releaseError: new Error('wallet timeout'),
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'REPAIR_PERSISTENCE_UNAVAILABLE',
      retryable: true,
    });
    const stored = repository.idempotencies.get(`${USER_ID}:idem-1`);
    expect(stored).toMatchObject({
      proposedTaskId: TASK_ID,
      quotedPoints: '1200',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
      phase: 'COMPENSATION_REQUESTED',
    });

    await expect(service.execute(command, 'idem-1')).rejects.toMatchObject({
      code: 'TASK_CREATION_REPAIR_REQUIRED',
      retryable: false,
    });
    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.release).toHaveBeenCalledTimes(1);
    expect(repository.repairCases).toHaveLength(1);
  });

  it('promotes a stalled financial phase to one durable repair on a later identical request', async () => {
    const repository = new MemoryTaskCreationRepository();
    repository.phaseUpdateFailures = Array.from(
      { length: 6 },
      () => new Error('database unavailable'),
    );
    const { service, wallet } = harness({ repository });

    await expect(service.execute(command, 'idem-recover-repair')).rejects.toMatchObject({
      code: 'REPAIR_PERSISTENCE_UNAVAILABLE',
    });
    await expect(service.execute(command, 'idem-recover-repair')).rejects.toMatchObject({
      code: 'TASK_CREATION_REPAIR_REQUIRED',
    });
    await expect(service.execute(command, 'idem-recover-repair')).rejects.toMatchObject({
      code: 'TASK_CREATION_REPAIR_REQUIRED',
    });

    expect(wallet.reserve).toHaveBeenCalledTimes(1);
    expect(wallet.release).not.toHaveBeenCalled();
    expect(repository.tasks.size).toBe(0);
    expect(repository.outbox.size).toBe(0);
    expect(repository.repairCases).toHaveLength(1);
    expect(repository.repairCases[0]).toMatchObject({
      phase: 'RESERVE_REQUESTED',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
    });
  });

  it('persists immutable snapshots, two audited transitions, and a contract envelope', async () => {
    const { repository, service } = harness();

    await service.execute(command, 'idem-1', { traceId: 'a'.repeat(32) });

    const persisted = repository.tasks.get(TASK_ID);
    expect(persisted).toMatchObject({
      taskId: TASK_ID,
      userId: USER_ID,
      quoteId: QUOTE_ID,
      capabilityVersionId: CAPABILITY_VERSION_ID,
      status: 'QUEUED' satisfies TaskStatus,
      version: 2,
      quoteSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      capabilitySnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      pricingSnapshotSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      parametersSnapshotSha256: sha256(command.parameters),
      transitions: [
        {
          id: RESERVED_TRANSITION_ID,
          fromStatus: 'QUOTED',
          toStatus: 'RESERVED',
          taskVersion: 1,
          reasonCode: 'POINTS_RESERVED',
          source: 'API',
          actorType: 'USER',
          actorId: USER_ID,
          traceId: 'a'.repeat(32),
        },
        {
          id: QUEUED_TRANSITION_ID,
          fromStatus: 'RESERVED',
          toStatus: 'QUEUED',
          taskVersion: 2,
          reasonCode: 'TASK_CREATED',
          source: 'API',
          actorType: 'USER',
          actorId: USER_ID,
          traceId: 'a'.repeat(32),
        },
      ],
    });
    expect(persisted?.event).toMatchObject({
      id: OUTBOX_ID,
      type: 'generation.task-queued.v1',
      version: 1,
      occurredAt: NOW.toISOString(),
      traceId: 'a'.repeat(32),
      correlationId: TASK_ID,
      producer: 'generation-service',
      data: {
        taskId: TASK_ID,
        userId: USER_ID,
        status: 'QUEUED',
        taskVersion: 2,
      },
    });
    expect(repository.idempotencies.get(`${USER_ID}:idem-1`)).toMatchObject({
      proposedTaskId: TASK_ID,
      quotedPoints: '1200',
      reserveBusinessKey: `task:${TASK_ID}:reserve`,
      compensationBusinessKey: `task:${TASK_ID}:create-compensation`,
      traceId: 'a'.repeat(32),
      phase: 'SUCCEEDED',
    });
  });
});
