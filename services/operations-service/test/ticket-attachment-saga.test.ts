import { describe, expect, it } from 'vitest';
import {
  InMemoryTicketRepository,
  TicketService,
  type AttachmentAuthorizationPort,
  type AttachmentReservation,
  type TicketRepository,
  type TicketScope,
  type TicketState,
} from '../src/application/ticket.service.js';

const USER = '01990f24-2ba2-7000-8000-000000000001';
const ASSET = '01990f24-2ba2-7000-8000-000000000002';
const SESSION = '01990f24-2ba2-7000-8000-000000000003';
const ADMIN = '01990f24-2ba2-7000-8000-000000000004';
const REMOTE_OPERATION = '01990f24-2ba2-7000-8000-000000000006';
const FENCE = '01990f24-2ba2-7000-8000-000000000007';
const context = {
  traceId: '0123456789abcdef0123456789abcdef',
  correlationId: '01990f24-2ba2-7000-8000-000000000005',
};

describe('support upload attachment saga', () => {
  it('persists the intent before reserve and replays a finalize crash window', async () => {
    const repository = new InMemoryTicketRepository();
    const saga = new FakeSaga(repository);
    saga.failFinalize = true;
    const service = makeService(repository, saga);
    await expect(
      service.create(
        { subject: 'crash window', body: 'initial', attachments: [attachment()] },
        USER,
        context,
      ),
    ).resolves.toMatchObject({ status: 'OPEN' });
    expect(saga.statusAtReserve).toBe('RESERVING');
    const pending = await singleBinding(repository);
    expect(pending?.status).toBe('FINALIZE_PENDING');
    expect(pending?.ownershipToken).toContain('ownership-token-');
    expect(pending?.sourceType).toBe('TICKET_MESSAGE');
    saga.failFinalize = false;
    await makeDue(repository);
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    await expect(singleBinding(repository)).resolves.toMatchObject({ status: 'FINALIZED' });
  });

  it.each([
    [
      'mismatched',
      (reservation: AttachmentReservation) => ({ ...reservation, ownerId: ADMIN }),
      'ATTACHMENT_NOT_AUTHORIZED',
    ],
    [
      'expired',
      (reservation: AttachmentReservation) => ({
        ...reservation,
        expiresAt: new Date('2026-08-31T23:59:59.999Z'),
      }),
      'SUPPORT_UPLOAD_SESSION_EXPIRED',
    ],
  ] as const)(
    'durably records and releases a %s remote reservation',
    async (_label, mutate, code) => {
      const repository = new InMemoryTicketRepository();
      const saga = new FakeSaga(repository);
      saga.mutateReservation = mutate;
      const service = makeService(repository, saga);
      await expect(
        service.create(
          { subject: 'invalid reservation', body: 'initial', attachments: [attachment()] },
          USER,
          context,
        ),
      ).rejects.toMatchObject({ code });
      await expect(singleBinding(repository)).resolves.toMatchObject({
        status: 'RELEASED',
        sourceId: null,
      });
      expect(saga.released).toHaveLength(1);
      expect(typeof saga.released[0]?.operationId).toBe('string');
      expect(saga.released[0]?.requestHash).toMatch(/^[a-f0-9]{64}$/);
      expect(saga.released[0]?.ownershipToken).toContain('ownership-token-');
    },
  );

  it('keeps a failed local transaction in RELEASE_PENDING and the worker eventually releases it', async () => {
    const base = new InMemoryTicketRepository();
    const repository = new FailBusinessOnceRepository(base);
    const saga = new FakeSaga(base);
    saga.releaseFailures = 1;
    const service = makeService(repository, saga);
    await expect(
      service.create(
        { subject: 'db fail', body: 'initial', attachments: [attachment()] },
        USER,
        context,
      ),
    ).rejects.toThrow('database unavailable');
    await expect(singleBinding(base)).resolves.toMatchObject({
      status: 'RELEASE_PENDING',
      lastError: 'RELEASE_FAILED',
    });
    await makeDue(base);
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    await expect(singleBinding(base)).resolves.toMatchObject({
      status: 'RELEASED',
      lastError: null,
    });
    expect(saga.released).toHaveLength(1);
  });

  it('releases with the returned token when persisting RESERVED fails', async () => {
    const base = new InMemoryTicketRepository();
    const repository = new FailReservePersistenceOnceRepository(base);
    const saga = new FakeSaga(base);
    const service = makeService(repository, saga);
    await expect(
      service.create(
        { subject: 'reserve persistence fail', body: 'initial', attachments: [attachment()] },
        USER,
        context,
      ),
    ).rejects.toThrow('reserve persistence unavailable');
    await expect(singleBinding(base)).resolves.toMatchObject({
      status: 'RELEASED',
      reservationId: SESSION,
      ownershipToken: 'ownership-token-0001',
    });
    expect(saga.released).toHaveLength(1);
    expect(saga.released[0]?.requestHash).toMatch(/^[a-f0-9]{64}$/);
    expect(saga.released[0]?.ownershipToken).toBe('ownership-token-0001');
  });

  it('recovers a crash between remote reserve and persisting the ownership token', async () => {
    const repository = new InMemoryTicketRepository();
    const saga = new FakeSaga(repository);
    const service = makeService(repository, saga);
    const operationId = `crash-operation:${ASSET}`;
    const requestHash = 'c'.repeat(64);
    const reservation: AttachmentReservation = {
      id: SESSION,
      operationId,
      remoteOperationId: REMOTE_OPERATION,
      generation: 0,
      fence: FENCE,
      requestHash,
      ownershipToken: 'ownership-token-crash',
      sessionId: SESSION,
      assetId: ASSET,
      ownerId: USER,
      purpose: 'SUPPORT_TICKET',
      expiresAt: new Date('2026-09-02T00:00:00.000Z'),
    };
    saga.reservations.set(REMOTE_OPERATION, reservation);
    await repository.transact({ kind: 'all' }, (state) =>
      state.bindings.set('01990f24-2ba2-7000-8000-000000000099', {
        id: '01990f24-2ba2-7000-8000-000000000099',
        operationId,
        generation: 0,
        remoteOperationId: REMOTE_OPERATION,
        fence: FENCE,
        requestHash,
        idempotencyKey: 'crash-key',
        reservationId: null,
        ownershipToken: null,
        sessionId: SESSION,
        ownerId: USER,
        assetId: ASSET,
        sourceType: null,
        sourceId: null,
        status: 'RESERVING',
        attempts: 0,
        nextAttemptAt: new Date('2026-08-31T23:59:00.000Z'),
        claimToken: null,
        leaseUntil: null,
        lastError: null,
        createdAt: new Date('2026-08-31T23:58:00.000Z'),
        finalizedAt: null,
      }),
    );
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    await expect(singleBinding(repository)).resolves.toMatchObject({
      status: 'RELEASED',
      reservationId: SESSION,
      ownershipToken: 'ownership-token-crash',
    });
    expect(saga.released).toEqual([reservation]);
  });

  it('replays reserve then release when a stale intent has no remote reservation yet', async () => {
    const repository = new InMemoryTicketRepository();
    const saga = new FakeSaga(repository);
    const service = makeService(repository, saga);
    const operationId = `intent-before-remote:${ASSET}`;
    await repository.transact({ kind: 'all' }, (state) =>
      state.bindings.set('01990f24-2ba2-7000-8000-000000000098', {
        id: '01990f24-2ba2-7000-8000-000000000098',
        operationId,
        generation: 0,
        remoteOperationId: REMOTE_OPERATION,
        fence: FENCE,
        requestHash: 'd'.repeat(64),
        idempotencyKey: 'crash-before-remote',
        reservationId: null,
        ownershipToken: null,
        sessionId: SESSION,
        ownerId: USER,
        assetId: ASSET,
        sourceType: null,
        sourceId: null,
        status: 'RESERVING',
        attempts: 0,
        nextAttemptAt: new Date('2026-08-31T23:59:00.000Z'),
        claimToken: null,
        leaseUntil: null,
        lastError: null,
        createdAt: new Date('2026-08-31T23:58:00.000Z'),
        finalizedAt: null,
      }),
    );
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    await expect(singleBinding(repository)).resolves.toMatchObject({ status: 'RELEASED' });
    expect(saga.reserveCalls).toBe(1);
    expect(saga.released).toHaveLength(1);
  });

  it('keeps a foreground identity-mismatch tuple in an independent durable compensation', async () => {
    const repository = new InMemoryTicketRepository();
    const saga = new FakeSaga(repository);
    const mismatchedRemoteOperationId = '01990f24-2ba2-7000-8000-000000000088';
    saga.mutateReservation = (reservation) => ({
      ...reservation,
      remoteOperationId: mismatchedRemoteOperationId,
    });
    saga.releaseFailures = 1;
    const service = makeService(repository, saga);
    await expect(
      service.create(
        { subject: 'mismatched tuple', body: 'initial', attachments: [attachment()] },
        USER,
        context,
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_NOT_AUTHORIZED' });
    await expect(singleBinding(repository)).resolves.toMatchObject({ ownershipToken: null });
    expect(await compensationRows(repository)).toEqual([
      expect.objectContaining({
        status: 'RELEASE_PENDING',
        remoteOperationId: mismatchedRemoteOperationId,
      }),
    ]);
    await makeDue(repository);
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    expect(await compensationRows(repository)).toEqual([
      expect.objectContaining({
        status: 'RELEASED',
        remoteOperationId: mismatchedRemoteOperationId,
      }),
    ]);
  });

  it('strictly rejects a worker replay identity mismatch before binding and compensates the raw tuple', async () => {
    const repository = new InMemoryTicketRepository();
    const saga = new FakeSaga(repository);
    const rawFence = '01990f24-2ba2-7000-8000-000000000087';
    saga.mutateReservation = (reservation) => ({ ...reservation, fence: rawFence });
    const service = makeService(repository, saga);
    const operationId = `worker-mismatch:${ASSET}`;
    await repository.transact({ kind: 'all' }, (state) =>
      state.bindings.set('01990f24-2ba2-7000-8000-000000000086', {
        id: '01990f24-2ba2-7000-8000-000000000086',
        operationId,
        generation: 0,
        remoteOperationId: REMOTE_OPERATION,
        fence: FENCE,
        requestHash: 'e'.repeat(64),
        idempotencyKey: 'worker-mismatch',
        reservationId: null,
        ownershipToken: null,
        sessionId: SESSION,
        ownerId: USER,
        assetId: ASSET,
        sourceType: null,
        sourceId: null,
        status: 'RESERVING',
        attempts: 0,
        nextAttemptAt: new Date('2026-08-31T23:59:00.000Z'),
        claimToken: null,
        leaseUntil: null,
        lastError: null,
        createdAt: new Date('2026-08-31T23:58:00.000Z'),
        finalizedAt: null,
      }),
    );
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    await expect(singleBinding(repository)).resolves.toMatchObject({
      status: 'CANCELLED',
      ownershipToken: null,
    });
    expect(await compensationRows(repository)).toEqual([
      expect.objectContaining({ status: 'RELEASED', fence: rawFence }),
    ]);
  });

  it('rearms a released generation for the same request but keeps a different body conflicting', async () => {
    const base = new InMemoryTicketRepository();
    const saga = new FakeSaga(base);
    const setup = makeService(base, saga, 0x500);
    const claimed = await claimedTicket(setup);
    const repository = new FailBusinessOnceRepository(base);
    const service = makeService(repository, saga, 0x600);
    saga.releaseFailures = 1;
    const request = {
      body: 'retryable reply',
      expectedRevision: claimed.revision,
      attachments: [attachment()],
    };
    await expect(service.reply(claimed.id, request, ADMIN, 'retry-key', context)).rejects.toThrow(
      'database unavailable',
    );
    await makeDue(base);
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    await expect(singleBinding(base)).resolves.toMatchObject({ status: 'RELEASED', generation: 0 });
    await expect(
      service.reply(claimed.id, request, ADMIN, 'retry-key', context),
    ).resolves.toMatchObject({ message: { body: 'retryable reply' } });
    await expect(singleBinding(base)).resolves.toMatchObject({
      status: 'FINALIZED',
      generation: 1,
    });
    expect(saga.reserveCalls).toBe(2);
    await expect(
      service.reply(
        claimed.id,
        { ...request, body: 'different body', expectedRevision: claimed.revision + 1 },
        ADMIN,
        'retry-key',
        context,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('returns the idempotent winner for concurrent duplicate messages without a second reserve', async () => {
    const repository = new InMemoryTicketRepository();
    const saga = new FakeSaga(repository);
    const service = makeService(repository, saga);
    const claimed = await claimedTicket(service);
    const calls = await Promise.all([
      service.reply(
        claimed.id,
        { body: 'same', expectedRevision: claimed.revision, attachments: [attachment()] },
        ADMIN,
        'same-key',
        context,
      ),
      service.reply(
        claimed.id,
        { body: 'same', expectedRevision: claimed.revision, attachments: [attachment()] },
        ADMIN,
        'same-key',
        context,
      ),
    ]);
    expect(calls[0].message.id).toBe(calls[1].message.id);
    expect(saga.reserveCalls).toBe(1);
    expect(saga.released).toHaveLength(0);
  });

  it('makes a same-key different-body loser wait for the winner and never release its token', async () => {
    const repository = new InMemoryTicketRepository();
    const saga = new FakeSaga(repository);
    const service = makeService(repository, saga);
    const claimed = await claimedTicket(service);
    const gate = deferred();
    saga.reserveGate = gate.promise;
    const winner = service.reply(
      claimed.id,
      { body: 'winner body', expectedRevision: claimed.revision, attachments: [attachment()] },
      ADMIN,
      'racing-key',
      context,
    );
    await saga.reserveStarted.promise;
    const loser = service.reply(
      claimed.id,
      { body: 'different body', expectedRevision: claimed.revision, attachments: [attachment()] },
      ADMIN,
      'racing-key',
      context,
    );
    gate.resolve();
    await expect(winner).resolves.toMatchObject({ message: { body: 'winner body' } });
    await expect(loser).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(saga.reserveCalls).toBe(1);
    expect(saga.released).toHaveLength(0);
    await expect(singleBinding(repository)).resolves.toMatchObject({ status: 'FINALIZED' });
  });

  it('fences an original request that returns after its released generation was rearmed', async () => {
    const repository = new InMemoryTicketRepository();
    const saga = new FakeSaga(repository);
    let now = new Date('2026-09-01T00:00:00.000Z');
    const service = makeService(repository, saga, 0x700, () => now);
    const claimed = await claimedTicket(service);
    const gate = deferred();
    saga.reserveGate = gate.promise;
    saga.failReleaseCalls.add(2);
    const request = {
      body: 'fenced reply',
      expectedRevision: claimed.revision,
      attachments: [attachment()],
    };
    const original = service.reply(claimed.id, request, ADMIN, 'fenced-key', context);
    await saga.reserveStarted.promise;
    now = new Date('2026-09-01T00:00:31.000Z');
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    await expect(singleBinding(repository)).resolves.toMatchObject({
      status: 'RELEASED',
      generation: 0,
    });
    const retry = await service.reply(claimed.id, request, ADMIN, 'fenced-key', context);
    gate.resolve();
    const originalResult = await original;
    expect(originalResult.message.id).toBe(retry.message.id);
    const binding = await singleBinding(repository);
    expect(binding).toMatchObject({
      status: 'FINALIZED',
      generation: 1,
      ownershipToken: 'ownership-token-0003',
    });
    expect(saga.released.length).toBeGreaterThanOrEqual(1);
    expect(saga.released.every((reservation) => reservation.generation === 0)).toBe(true);
    expect(await compensationRows(repository)).toEqual([
      expect.objectContaining({ status: 'RELEASE_PENDING', generation: 0 }),
    ]);
    await makeDue(repository);
    await expect(service.retryPendingAttachmentFinalizations()).resolves.toBe(1);
    expect(await compensationRows(repository)).toEqual([
      expect.objectContaining({ status: 'RELEASED', generation: 0 }),
    ]);
    await expect(singleBinding(repository)).resolves.toMatchObject({
      status: 'FINALIZED',
      generation: 1,
      ownershipToken: 'ownership-token-0003',
    });
  });
});

class FakeSaga implements AttachmentAuthorizationPort {
  failFinalize = false;
  releaseFailures = 0;
  releaseCalls = 0;
  readonly failReleaseCalls = new Set<number>();
  reserveCalls = 0;
  reserveGate: Promise<void> | null = null;
  mutateReservation: ((reservation: AttachmentReservation) => AttachmentReservation) | null = null;
  statusAtReserve: string | undefined;
  readonly released: AttachmentReservation[] = [];
  readonly reservations = new Map<string, AttachmentReservation>();
  readonly reserveStarted = deferred();
  constructor(private readonly repository: TicketRepository) {}

  async reserve(input: {
    operationId: string;
    remoteOperationId: string;
    generation: number;
    fence: string;
    requestHash: string;
    assetId: string;
    ownerId: string;
  }): Promise<AttachmentReservation> {
    this.reserveCalls += 1;
    this.statusAtReserve = [
      ...(await this.repository.snapshot({ kind: 'all' })).bindings.values(),
    ].find((binding) => binding.operationId === input.operationId)?.status;
    this.reserveStarted.resolve();
    const gate = this.reserveGate;
    this.reserveGate = null;
    await gate;
    const existing = this.reservations.get(input.remoteOperationId);
    if (existing !== undefined) return existing;
    const original: AttachmentReservation = {
      id: SESSION,
      operationId: input.operationId,
      remoteOperationId: input.remoteOperationId,
      generation: input.generation,
      fence: input.fence,
      requestHash: input.requestHash,
      ownershipToken: `ownership-token-${this.reserveCalls.toString().padStart(4, '0')}`,
      sessionId: SESSION,
      assetId: input.assetId,
      ownerId: input.ownerId,
      purpose: 'SUPPORT_TICKET',
      expiresAt: new Date('2026-09-02T00:00:00.000Z'),
    };
    const reservation = this.mutateReservation?.(original) ?? original;
    this.reservations.set(input.remoteOperationId, {
      ...reservation,
      operationId: input.operationId,
      remoteOperationId: input.remoteOperationId,
      generation: input.generation,
      fence: input.fence,
      requestHash: input.requestHash,
    });
    return reservation;
  }
  finalize(): Promise<void> {
    return this.failFinalize
      ? Promise.reject(new Error('finalize unavailable'))
      : Promise.resolve();
  }
  release(reservation: AttachmentReservation): Promise<void> {
    this.releaseCalls += 1;
    if (this.failReleaseCalls.has(this.releaseCalls))
      return Promise.reject(new Error('release unavailable'));
    if (this.releaseFailures > 0) {
      this.releaseFailures -= 1;
      return Promise.reject(new Error('release unavailable'));
    }
    this.released.push(reservation);
    return Promise.resolve();
  }
  lookup(remoteOperationId: string): Promise<AttachmentReservation | null> {
    return Promise.resolve(this.reservations.get(remoteOperationId) ?? null);
  }
}

class FailBusinessOnceRepository implements TicketRepository {
  #failed = false;
  constructor(private readonly delegate: TicketRepository) {}
  snapshot(scope: TicketScope): Promise<TicketState> {
    return this.delegate.snapshot(scope);
  }
  transact<T>(scope: TicketScope, work: (state: TicketState) => T | Promise<T>): Promise<T> {
    if (!this.#failed && scope.kind === 'ticket' && scope.bindingIds !== undefined) {
      this.#failed = true;
      return Promise.reject(new Error('database unavailable'));
    }
    return this.delegate.transact(scope, work);
  }
}

class FailReservePersistenceOnceRepository implements TicketRepository {
  #allTransactions = 0;
  constructor(private readonly delegate: TicketRepository) {}
  snapshot(scope: TicketScope): Promise<TicketState> {
    return this.delegate.snapshot(scope);
  }
  transact<T>(scope: TicketScope, work: (state: TicketState) => T | Promise<T>): Promise<T> {
    if (scope.kind === 'all' && ++this.#allTransactions === 3)
      return Promise.reject(new Error('reserve persistence unavailable'));
    return this.delegate.transact(scope, work);
  }
}

function attachment(): { assetId: string; supportUploadSessionId: string } {
  return { assetId: ASSET, supportUploadSessionId: SESSION };
}
async function claimedTicket(service: TicketService) {
  const ticket = await service.create({ subject: 'duplicate', body: 'initial' }, USER, context);
  return service.claim(ticket.id, ticket.revision, ADMIN, context);
}
async function singleBinding(repository: TicketRepository) {
  return [...(await repository.snapshot({ kind: 'all' })).bindings.values()][0];
}
async function makeDue(repository: TicketRepository) {
  await repository.transact({ kind: 'all' }, (state) => {
    for (const [id, binding] of state.bindings)
      state.bindings.set(id, { ...binding, nextAttemptAt: new Date('2026-08-31T23:59:00.000Z') });
    for (const [id, compensation] of state.compensations)
      state.compensations.set(id, {
        ...compensation,
        nextAttemptAt: new Date('2026-08-31T23:59:00.000Z'),
      });
  });
}
async function compensationRows(repository: TicketRepository) {
  return [...(await repository.snapshot({ kind: 'all' })).compensations.values()];
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeService(
  repository: TicketRepository,
  attachmentAuthorization: AttachmentAuthorizationPort,
  seed = 0x100,
  now: () => Date = () => new Date('2026-09-01T00:00:00.000Z'),
): TicketService {
  let id = seed;
  return new TicketService({
    repository,
    attachmentAuthorization,
    feedbackSubjectAuthorization: { assertTaskOwned: () => Promise.resolve() },
    now,
    id: () => `01990f24-2ba2-7000-8000-${(id++).toString(16).padStart(12, '0')}`,
  });
}
