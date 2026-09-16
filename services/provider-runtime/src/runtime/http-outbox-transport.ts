import { EventEnvelopeSchema, HEADERS, type EventEnvelope } from '@repo/contracts/common';
import type { PrismaClient } from '../generated/prisma/client.js';

interface OutboxRow {
  readonly id: string;
  readonly eventType: string;
  readonly eventVersion: number;
  readonly deduplicationKey: string | null;
  readonly payload: unknown;
  readonly headers: unknown;
  readonly occurredAt: Date;
  readonly attempts: number;
}

export interface HttpOutboxTransportOptions {
  readonly publishUrl: URL;
  readonly readyUrl: URL;
  readonly bearerToken: string;
  readonly batchSize?: number;
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
}

export class ProviderHttpOutboxTransport {
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly batchSize: number;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private activePublish: Promise<{ readonly published: number }> | undefined;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly options: HttpOutboxTransportOptions,
  ) {
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.batchSize = boundedInteger(options.batchSize ?? 50, 1, 100, 'INVALID_OUTBOX_BATCH_SIZE');
    this.timeoutMs = boundedInteger(
      options.timeoutMs ?? 3_000,
      100,
      30_000,
      'INVALID_OUTBOX_TIMEOUT',
    );
    this.maxAttempts = boundedInteger(
      options.maxAttempts ?? 10,
      1,
      100,
      'INVALID_OUTBOX_MAX_ATTEMPTS',
    );
  }

  async ready(): Promise<boolean> {
    try {
      const response = await this.fetcher(this.options.readyUrl, {
        method: 'GET',
        headers: { authorization: `Bearer ${this.options.bearerToken}` },
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  publishPending(): Promise<{ readonly published: number }> {
    if (this.activePublish !== undefined) return this.activePublish;
    const operation = this.publishBatch().finally(() => {
      if (this.activePublish === operation) this.activePublish = undefined;
    });
    this.activePublish = operation;
    return operation;
  }

  private async publishBatch(): Promise<{ readonly published: number }> {
    const now = this.now();
    const rows = await this.prisma.outboxEvent.findMany({
      where: { publishedAt: null, availableAt: { lte: now }, attempts: { lt: this.maxAttempts } },
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      take: this.batchSize,
      select: {
        id: true,
        eventType: true,
        eventVersion: true,
        deduplicationKey: true,
        payload: true,
        headers: true,
        occurredAt: true,
        attempts: true,
      },
    });
    let published = 0;
    for (const row of rows as OutboxRow[]) {
      const envelope = toEnvelope(row);
      if (envelope === null) {
        await this.recordFailure(row, 'INVALID_EVENT_ENVELOPE');
        continue;
      }
      let response: Response;
      try {
        response = await this.fetcher(this.options.publishUrl, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${this.options.bearerToken}`,
            'content-type': 'application/json',
            [HEADERS.idempotencyKey]: row.deduplicationKey ?? row.id,
          },
          body: JSON.stringify(envelope),
          redirect: 'error',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch {
        await this.recordFailure(row, 'TRANSPORT_REQUEST_FAILED');
        continue;
      }
      if (!response.ok) {
        await this.recordFailure(row, `TRANSPORT_HTTP_${String(response.status)}`);
        continue;
      }
      const marked = await this.prisma.outboxEvent.updateMany({
        where: { id: row.id, publishedAt: null, attempts: row.attempts },
        data: { publishedAt: this.now(), attempts: { increment: 1 }, lastError: null },
      });
      if (marked.count === 1) published += 1;
    }
    return { published };
  }

  private async recordFailure(row: OutboxRow, lastError: string): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id: row.id, publishedAt: null, attempts: row.attempts },
      data: { attempts: { increment: 1 }, lastError },
    });
  }
}

function toEnvelope(row: OutboxRow): EventEnvelope | null {
  if (!isRecord(row.headers)) return null;
  const parsed = EventEnvelopeSchema.safeParse({
    ...row.headers,
    id: row.id,
    type: row.eventType,
    version: row.eventVersion,
    occurredAt: row.occurredAt.toISOString(),
    data: row.payload,
  });
  return parsed.success ? parsed.data : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boundedInteger(value: number, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) throw new Error(code);
  return value;
}
