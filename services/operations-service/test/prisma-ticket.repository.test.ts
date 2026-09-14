import { describe, expect, it } from 'vitest';
import { PrismaTicketRepository } from '../src/adapters/prisma-ticket.repository.js';

const USER = '01990f24-2ba2-7000-8000-000000000001';
const TICKET = '01990f24-2ba2-7000-8000-000000000002';

describe('PrismaTicketRepository production boundaries', () => {
  it('scopes user ticket reads in SQL and never loads internal notes', async () => {
    const calls: Array<{ delegate: string; method: string; args: unknown }> = [];
    const client = clientFor(calls, { ticket: [] });
    await new PrismaTicketRepository(client as never).snapshot({
      kind: 'ticket',
      ticketId: TICKET,
      userId: USER,
    });
    expect(calls).toContainEqual({
      delegate: 'ticket',
      method: 'findFirst',
      args: { where: { id: TICKET, userId: USER } },
    });
    expect(calls.some((call) => call.delegate === 'ticketInternalNote')).toBe(false);
  });

  it('pushes stable keyset pagination into the production ticket query', async () => {
    const calls: Array<{ delegate: string; method: string; args: unknown }> = [];
    const client = clientFor(calls, { ticket: [] });
    const before = { createdAt: new Date('2026-09-01T00:00:00.000Z'), id: TICKET };
    await new PrismaTicketRepository(client as never).snapshot({
      kind: 'ticket',
      userId: USER,
      page: { limit: 21, before },
    });
    expect(
      calls.find((call) => call.delegate === 'ticket' && call.method === 'findMany')?.args,
    ).toEqual({
      where: {
        userId: USER,
        OR: [
          { createdAt: { lt: before.createdAt } },
          { createdAt: before.createdAt, id: { lt: TICKET } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
  });

  it('persists ticket revision with a status/revision CAS and outbox in one transaction', async () => {
    const calls: Array<{ delegate: string; method: string; args: unknown }> = [];
    const ticket = {
      id: TICKET,
      userId: USER,
      subject: '问题',
      status: 'OPEN',
      assigneeId: null,
      revision: 0,
      resolvedAt: null,
      closedAt: null,
      createdAt: new Date('2026-09-01T00:00:00Z'),
      updatedAt: new Date('2026-09-01T00:00:00Z'),
    };
    const client = clientFor(calls, { ticket: [ticket] });
    const repository = new PrismaTicketRepository(client as never);
    await repository.transact({ kind: 'ticket', ticketId: TICKET }, (state) => {
      const current = state.tickets.get(TICKET);
      if (current === undefined) throw new Error('missing');
      state.tickets.set(TICKET, {
        ...current,
        status: 'IN_PROGRESS',
        assigneeId: '01990f24-2ba2-7000-8000-000000000003',
        revision: 1,
      });
      state.outbox.push({
        id: '01990f24-2ba2-7000-8000-000000000004',
        type: 'operations.ticket.claimed.v1',
        version: 1,
        occurredAt: '2026-09-01T00:00:00.000Z',
        traceId: '0123456789abcdef0123456789abcdef',
        correlationId: '01990f24-2ba2-7000-8000-000000000005',
        producer: 'operations-service',
        data: {},
        status: 'PENDING',
        attempts: 0,
        createdAt: new Date('2026-09-01T00:00:00Z'),
      });
    });
    const update = calls.find((call) => call.delegate === 'ticket' && call.method === 'updateMany');
    expect((update?.args as { where: unknown }).where).toEqual({
      id: TICKET,
      revision: 0,
      status: 'OPEN',
    });
    expect(calls.some((call) => call.delegate === 'outboxEvent' && call.method === 'create')).toBe(
      true,
    );
  });

  it('maps a failed CAS to TICKET_REVISION_CONFLICT', async () => {
    const ticket = {
      id: TICKET,
      userId: USER,
      subject: '问题',
      status: 'OPEN',
      assigneeId: null,
      revision: 0,
      resolvedAt: null,
      closedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const client = clientFor([], { ticket: [ticket], conflict: true });
    await expect(
      new PrismaTicketRepository(client as never).transact(
        { kind: 'ticket', ticketId: TICKET },
        (state) => {
          const current = state.tickets.get(TICKET);
          if (current !== undefined) state.tickets.set(TICKET, { ...current, revision: 1 });
        },
      ),
    ).rejects.toMatchObject({ code: 'TICKET_REVISION_CONFLICT' });
  });
});

function clientFor(
  calls: Array<{ delegate: string; method: string; args: unknown }>,
  input: { ticket: Array<Record<string, unknown>>; conflict?: boolean },
) {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    ticket: structuredClone(input.ticket),
    ticketMessage: [],
    ticketMessageAttachment: [],
    ticketInternalNote: [],
    feedback: [],
    feedbackAttachment: [],
    supportUploadConsumption: [],
    outboxEvent: [],
  };
  return {
    $transaction: async <T>(work: (tx: Record<string, unknown>) => Promise<T>) =>
      work(
        Object.fromEntries(
          Object.entries(rows).map(([name, values]) => [
            name,
            delegate(name, values, calls, input.conflict === true),
          ]),
        ),
      ),
  };
}

function delegate(
  name: string,
  rows: Array<Record<string, unknown>>,
  calls: Array<{ delegate: string; method: string; args: unknown }>,
  conflict: boolean,
) {
  return {
    findFirst: (args: unknown) => {
      calls.push({ delegate: name, method: 'findFirst', args });
      const where = (args as { where?: Record<string, unknown> }).where ?? {};
      return Promise.resolve(
        structuredClone(
          rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ??
            null,
        ),
      );
    },
    findUnique: (args: unknown) => {
      calls.push({ delegate: name, method: 'findUnique', args });
      const where = (args as { where: Record<string, unknown> }).where;
      return Promise.resolve(
        structuredClone(
          rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ??
            null,
        ),
      );
    },
    findMany: (args: unknown = {}) => {
      calls.push({ delegate: name, method: 'findMany', args });
      const where = (args as { where?: Record<string, unknown> }).where;
      return Promise.resolve(
        structuredClone(
          where === undefined
            ? rows
            : rows.filter((row) =>
                Object.entries(where).every(([key, value]) => row[key] === value),
              ),
        ),
      );
    },
    create: (args: { data: Record<string, unknown> }) => {
      calls.push({ delegate: name, method: 'create', args });
      rows.push(structuredClone(args.data));
      return Promise.resolve(args.data);
    },
    updateMany: (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      calls.push({ delegate: name, method: 'updateMany', args });
      if (conflict && name === 'ticket') return Promise.resolve({ count: 0 });
      const row = rows.find((item) =>
        Object.entries(args.where).every(([key, value]) => item[key] === value),
      );
      if (row === undefined) return Promise.resolve({ count: 0 });
      Object.assign(row, structuredClone(args.data));
      return Promise.resolve({ count: 1 });
    },
  };
}
