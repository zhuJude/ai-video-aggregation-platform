/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-return -- narrow Prisma structural boundary. */
import { randomUUID } from 'node:crypto';
import type { ResultOutboxDispatcher } from '../application/result-import.service.js';

export interface AssetEventPublisher {
  publish(event: { id: string; type: string; payload: unknown }): Promise<void>;
}

const OUTBOX_LEASE_MS = 60_000;
const MAX_BACKOFF_MS = 15 * 60_000;

/** Durable lease-based outbox dispatcher; PUBLISHED rows make replay a no-op. */
export class PrismaOutboxDispatcher implements ResultOutboxDispatcher {
  constructor(
    private readonly client: { $transaction<T>(work: (tx: any) => Promise<T>): Promise<T> },
    private readonly publisher: AssetEventPublisher,
    private readonly token: () => string = randomUUID,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async dispatch(eventId: string): Promise<void> {
    const now = this.now();
    const claimToken = this.token();
    const event = await this.client.$transaction(async (tx) => {
      const row = await tx.outboxEvent.findUnique({ where: { id: eventId } });
      if (row === null || row.status === 'PUBLISHED') return null;
      if (row.leaseUntil !== null && row.leaseUntil > now) return null;
      if (row.nextAttemptAt !== undefined && row.nextAttemptAt > now) return null;
      const changed = await tx.outboxEvent.updateMany({
        where: {
          id: eventId,
          status: { in: ['PENDING', 'FAILED'] },
          nextAttemptAt: { lte: now },
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        },
        data: { claimToken, leaseUntil: new Date(now.getTime() + OUTBOX_LEASE_MS) },
      });
      return changed.count === 1
        ? { id: row.id as string, type: row.eventType as string, payload: row.payload as unknown, attempts: row.attempts as number }
        : null;
    });
    if (event === null) return;

    try {
      await this.publisher.publish({ id: event.id, type: event.type, payload: event.payload });
      await this.client.$transaction((tx) => tx.outboxEvent.updateMany({
        where: { id: eventId, claimToken, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'PUBLISHED', publishedAt: this.now(), claimToken: null, leaseUntil: null, lastError: null },
      }));
    } catch (error) {
      await this.client.$transaction((tx) => tx.outboxEvent.updateMany({
        where: { id: eventId, claimToken, status: { in: ['PENDING', 'FAILED'] } },
        data: { status: 'FAILED', attempts: { increment: 1 }, nextAttemptAt: new Date(this.now().getTime() + backoffMs(event.attempts)), lastError: 'EVENT_PUBLISH_FAILED', claimToken: null, leaseUntil: null },
      }));
      throw error;
    }
  }

  /** Scans durable due work so a process crash after the asset transaction cannot strand an event. */
  async dispatchDue(limit = 100): Promise<number> {
    const now = this.now();
    const rows = await this.client.$transaction((tx) => tx.outboxEvent.findMany({
      where: { status: { in: ['PENDING', 'FAILED'] }, nextAttemptAt: { lte: now }, OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }] },
      orderBy: { nextAttemptAt: 'asc' },
      select: { id: true },
      take: limit,
    }));
    let attempted = 0;
    for (const row of rows as Array<{ id: string }>) {
      try { await this.dispatch(row.id); } catch { /* each event retains its own retry schedule */ }
      attempted += 1;
    }
    return attempted;
  }
}

export class AssetOutboxJob {
  constructor(private readonly dispatcher: Pick<PrismaOutboxDispatcher, 'dispatchDue'>) {}
  run(): Promise<number> { return this.dispatcher.dispatchDue(); }
}

function backoffMs(previousAttempts: number): number {
  return Math.min(1_000 * 2 ** Math.min(previousAttempts, 20), MAX_BACKOFF_MS);
}
