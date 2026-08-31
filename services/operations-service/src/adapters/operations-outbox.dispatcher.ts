/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- narrow Prisma structural boundary. */
import { createUuidV7Generator } from '../domain/uuid-v7.js';
export interface EventEnvelope {
  id: string; type: string; version: number; occurredAt: string; traceId: string; correlationId: string;
  causationId?: string; producer: string; data: unknown;
}
export interface OutboxRecord extends EventEnvelope {
  status: 'PENDING' | 'FAILED' | 'PUBLISHED';
  attempts: number; nextAttemptAt: Date; leaseUntil: Date | null; claimToken: string | null;
  publishedAt: Date | null; lastError: string | null;
}

export interface OperationsOutboxStore {
  claim(id: string, now: Date, claimToken: string, leaseUntil: Date): Promise<OutboxRecord | null>;
  published(id: string, claimToken: string, at: Date): Promise<boolean>;
  failed(id: string, claimToken: string, at: Date, nextAttemptAt: Date): Promise<boolean>;
  due(now: Date, limit: number): Promise<string[]>;
}

export interface OperationsEventPublisher {
  publish(event: EventEnvelope): Promise<void>;
}

const LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/** Lease-based transactional-outbox dispatcher. Published rows make replay harmless. */
export class OperationsOutboxDispatcher {
  constructor(
    private readonly store: OperationsOutboxStore,
    private readonly publisher: OperationsEventPublisher,
    private readonly now: () => Date = () => new Date(),
    private readonly token: () => string = createUuidV7Generator(),
  ) {}

  async dispatch(eventId: string): Promise<void> {
    const claimedAt = this.now();
    const claimToken = this.token();
    const event = await this.store.claim(eventId, claimedAt, claimToken, new Date(claimedAt.getTime() + LEASE_MS));
    if (event === null) return;
    try {
      const { id, type, version, occurredAt, traceId, correlationId, causationId, producer, data } = event;
      await this.publisher.publish({ id, type, version, occurredAt, traceId, correlationId, ...(causationId === undefined ? {} : { causationId }), producer, data });
      await this.store.published(event.id, claimToken, this.now());
    } catch (error) {
      const failedAt = this.now();
      await this.store.failed(event.id, claimToken, failedAt, new Date(failedAt.getTime() + backoffMs(event.attempts)));
      throw error;
    }
  }

  async dispatchDue(limit = 100): Promise<number> {
    const ids = await this.store.due(this.now(), limit);
    for (const id of ids) {
      try { await this.dispatch(id); } catch { /* each row retains its durable retry schedule */ }
    }
    return ids.length;
  }
}

export class OperationsOutboxJob {
  constructor(private readonly dispatcher: Pick<OperationsOutboxDispatcher, 'dispatchDue'>) {}
  run(): Promise<number> { return this.dispatcher.dispatchDue(); }
}

export class InMemoryOutboxStore implements OperationsOutboxStore {
  readonly #records = new Map<string, OutboxRecord>();
  constructor(records: EventEnvelope[]) {
    for (const row of records) this.#records.set(row.id, {
      ...structuredClone(row), status: 'PENDING', attempts: 0, nextAttemptAt: new Date(0),
      leaseUntil: null, claimToken: null, publishedAt: null, lastError: null,
    });
  }
  get(id: string): OutboxRecord | undefined { const row = this.#records.get(id); return row === undefined ? undefined : structuredClone(row); }
  claim(id: string, now: Date, claimToken: string, leaseUntil: Date): Promise<OutboxRecord | null> {
    const row = this.#records.get(id);
    if (row === undefined || row.status === 'PUBLISHED' || row.nextAttemptAt > now || (row.leaseUntil !== null && row.leaseUntil > now)) return Promise.resolve(null);
    const claimed = { ...row, claimToken, leaseUntil };
    this.#records.set(id, claimed);
    return Promise.resolve(structuredClone(claimed));
  }
  published(id: string, claimToken: string, at: Date): Promise<boolean> {
    const row = this.#records.get(id);
    if (row?.claimToken !== claimToken || row.status === 'PUBLISHED') return Promise.resolve(false);
    this.#records.set(id, { ...row, status: 'PUBLISHED', publishedAt: at, claimToken: null, leaseUntil: null, lastError: null });
    return Promise.resolve(true);
  }
  failed(id: string, claimToken: string, _at: Date, nextAttemptAt: Date): Promise<boolean> {
    const row = this.#records.get(id);
    if (row?.claimToken !== claimToken || row.status === 'PUBLISHED') return Promise.resolve(false);
    this.#records.set(id, { ...row, status: 'FAILED', attempts: row.attempts + 1, nextAttemptAt, claimToken: null, leaseUntil: null, lastError: 'EVENT_PUBLISH_FAILED' });
    return Promise.resolve(true);
  }
  due(now: Date, limit: number): Promise<string[]> {
    return Promise.resolve([...this.#records.values()].filter((row) => row.status !== 'PUBLISHED' && row.nextAttemptAt <= now && (row.leaseUntil === null || row.leaseUntil <= now)).slice(0, limit).map((row) => row.id));
  }
}

/** Production store using guarded updates so multiple dispatcher replicas cannot double-claim. */
export class PrismaOperationsOutboxStore implements OperationsOutboxStore {
  constructor(private readonly client: { $transaction<T>(work: (tx: any) => Promise<T>): Promise<T> }) {}
  claim(id: string, now: Date, claimToken: string, leaseUntil: Date): Promise<OutboxRecord | null> {
    return this.client.$transaction(async (tx) => {
      const row = await tx.outboxEvent.findUnique({ where: { id } });
      if (row === null || row.status === 'PUBLISHED' || row.nextAttemptAt > now || (row.leaseUntil !== null && row.leaseUntil > now)) return null;
      const changed = await tx.outboxEvent.updateMany({
        where: { id, status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        data: { claimToken, leaseUntil },
      });
      const claimed = { ...row, claimToken, leaseUntil } as unknown as RawOutboxRecord;
      return changed.count === 1 ? normalizeRecord(claimed) : null;
    });
  }
  published(id: string, claimToken: string, at: Date): Promise<boolean> {
    return this.client.$transaction(async (tx) => (await tx.outboxEvent.updateMany({
      where: { id, claimToken, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'PUBLISHED', publishedAt: at, claimToken: null, leaseUntil: null, lastError: null },
    })).count === 1);
  }
  failed(id: string, claimToken: string, _at: Date, nextAttemptAt: Date): Promise<boolean> {
    return this.client.$transaction(async (tx) => (await tx.outboxEvent.updateMany({
      where: { id, claimToken, status: { in: ['PENDING', 'FAILED'] } },
      data: { status: 'FAILED', attempts: { increment: 1 }, nextAttemptAt, claimToken: null, leaseUntil: null, lastError: 'EVENT_PUBLISH_FAILED' },
    })).count === 1);
  }
  due(now: Date, limit: number): Promise<string[]> {
    return this.client.$transaction(async (tx) => {
      const rows = await tx.outboxEvent.findMany({
        where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
        orderBy: { nextAttemptAt: 'asc' }, select: { id: true }, take: limit,
      }) as Array<{ id: string }>;
      return rows.map((row) => row.id);
    });
  }
}

function backoffMs(previousAttempts: number): number { return Math.min(1_000 * 2 ** Math.min(previousAttempts, 20), MAX_BACKOFF_MS); }
type RawOutboxRecord = Omit<OutboxRecord, 'occurredAt' | 'causationId'> & { occurredAt: Date | string; causationId?: string | null };
function normalizeRecord(row: RawOutboxRecord): OutboxRecord {
  const { causationId, ...rest } = row;
  return { ...rest, occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
    ...(causationId == null ? {} : { causationId }) };
}
