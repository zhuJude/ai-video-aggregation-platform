/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- narrow Prisma structural boundary. */
import { isDeepStrictEqual } from 'node:util';
import {
  TicketError,
  type Feedback,
  type Ticket,
  type TicketInternalNote,
  type TicketMessage,
  type TicketRepository,
  type TicketScope,
  type TicketState,
  type SupportUploadBinding,
  type SupportUploadCompensation,
} from '../application/ticket.service.js';
import type { OperationsOutboxEvent } from '../application/publication.service.js';

interface PrismaTicketTransactionClient {
  ticket: any;
  ticketMessage: any;
  ticketMessageAttachment: any;
  ticketInternalNote: any;
  feedback: any;
  feedbackAttachment: any;
  supportUploadConsumption: any;
  supportUploadBinding: any;
  supportUploadCompensation: any;
  outboxEvent: any;
}

export interface PrismaTicketClient {
  $transaction<T>(work: (tx: PrismaTicketTransactionClient) => Promise<T>): Promise<T>;
}

/** Production ticket unit of work. Domain updates and their public outbox event commit together. */
export class PrismaTicketRepository implements TicketRepository {
  constructor(private readonly client: PrismaTicketClient) {}

  snapshot(scope: TicketScope): Promise<TicketState> { return this.client.$transaction((tx) => loadState(tx, scope)); }

  async transact<T>(scope: TicketScope, work: (state: TicketState) => T | Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction(async (tx) => {
        const before = await loadState(tx, scope);
        const after = cloneState(before);
        const result = await work(after);
        await persistState(tx, before, after);
        return structuredClone(result);
      });
    } catch (error) { throw mapPrismaError(error); }
  }
}

async function loadState(tx: PrismaTicketTransactionClient, scope: TicketScope): Promise<TicketState> {
  const state = emptyState();
  if (scope.kind === 'all') {
    addRows(state.tickets, await tx.ticket.findMany() as Ticket[]);
    await loadMessages(tx, state, [...state.tickets.keys()]);
    addRows(state.notes, await tx.ticketInternalNote.findMany() as TicketInternalNote[]);
    await loadFeedbackRows(tx, state, await tx.feedback.findMany() as FeedbackRow[]);
    addRows(state.bindings, await tx.supportUploadBinding.findMany() as SupportUploadBinding[]);
    addRows(state.compensations, await tx.supportUploadCompensation.findMany() as SupportUploadCompensation[]);
    return state;
  }
  if (scope.kind === 'ticket') {
    await loadBindings(tx, state, scope.bindingIds);
    if (scope.ticketId !== undefined) {
      const ticket = scope.userId === undefined
        ? await tx.ticket.findUnique({ where: { id: scope.ticketId } }) as Ticket | null
        : await tx.ticket.findFirst({ where: { id: scope.ticketId, userId: scope.userId } }) as Ticket | null;
      if (ticket !== null) {
        state.tickets.set(ticket.id, structuredClone(ticket));
        await loadMessages(tx, state, [ticket.id]);
        if (scope.userId === undefined) addRows(state.notes, await tx.ticketInternalNote.findMany({ where: { ticketId: ticket.id }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) as TicketInternalNote[]);
      }
    } else if (scope.userId !== undefined) {
      addRows(state.tickets, await tx.ticket.findMany({ where: { userId: scope.userId, ...pageWhere(scope.page?.before) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...(scope.page === undefined ? {} : { take: scope.page.limit }) }) as Ticket[]);
    }
    return state;
  }
  await loadBindings(tx, state, scope.bindingIds);
  if (scope.feedbackId !== undefined) {
    const row = scope.userId === undefined
      ? await tx.feedback.findUnique({ where: { id: scope.feedbackId } }) as FeedbackRow | null
      : await tx.feedback.findFirst({ where: { id: scope.feedbackId, userId: scope.userId } }) as FeedbackRow | null;
    if (row !== null) await loadFeedbackRows(tx, state, [row]);
  } else {
    const rows = await tx.feedback.findMany({ where: { ...(scope.userId === undefined ? {} : { userId: scope.userId }), ...pageWhere(scope.page?.before) }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...(scope.page === undefined ? {} : { take: scope.page.limit }) }) as FeedbackRow[];
    await loadFeedbackRows(tx, state, rows);
  }
  return state;
}

async function loadBindings(tx: PrismaTicketTransactionClient, state: TicketState, bindingIds: readonly string[] | undefined): Promise<void> {
  if (bindingIds === undefined || bindingIds.length === 0) return;
  addRows(state.bindings, await tx.supportUploadBinding.findMany({ where: { id: { in: [...bindingIds] } } }) as SupportUploadBinding[]);
}

async function loadMessages(tx: PrismaTicketTransactionClient, state: TicketState, ticketIds: string[]): Promise<void> {
  if (ticketIds.length === 0) return;
  const messages = await tx.ticketMessage.findMany({ where: { ticketId: { in: ticketIds } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }) as MessageRow[];
  const ids = messages.map((row) => row.id);
  const attachments = ids.length === 0 ? [] : await tx.ticketMessageAttachment.findMany({ where: { messageId: { in: ids } } }) as MessageAttachmentRow[];
  for (const row of messages) {
    state.messages.set(row.id, { ...structuredClone(row), attachments: attachments.filter((item) => item.messageId === row.id).map(stripMessageId) });
  }
}

async function loadFeedbackRows(tx: PrismaTicketTransactionClient, state: TicketState, rows: FeedbackRow[]): Promise<void> {
  const ids = rows.map((row) => row.id);
  const attachments = ids.length === 0 ? [] : await tx.feedbackAttachment.findMany({ where: { feedbackId: { in: ids } } }) as FeedbackAttachmentRow[];
  for (const row of rows) state.feedback.set(row.id, { ...structuredClone(row), attachments: attachments.filter((item) => item.feedbackId === row.id).map(stripFeedbackId) });
}

async function persistState(tx: PrismaTicketTransactionClient, before: TicketState, after: TicketState): Promise<void> {
  for (const [id, row] of after.tickets) {
    const previous = before.tickets.get(id);
    if (previous === undefined) await tx.ticket.create({ data: row });
    else if (!isDeepStrictEqual(previous, row)) {
      const changed = await tx.ticket.updateMany({ where: { id, revision: previous.revision, status: previous.status }, data: mutableData(row) });
      if (changed.count !== 1) throw new TicketError('TICKET_REVISION_CONFLICT');
    }
  }

  for (const [id, row] of after.messages) {
    if (before.messages.has(id)) continue;
    const { attachments, ...message } = row;
    await tx.ticketMessage.create({ data: message });
    const ownerId = after.tickets.get(row.ticketId)?.userId;
    if (ownerId === undefined) throw new TicketError('TICKET_NOT_FOUND');
    for (const attachment of attachments) {
      await tx.ticketMessageAttachment.create({ data: { ...attachment, messageId: id } });
      await persistConsumption(tx, attachment, ownerId, 'TICKET_MESSAGE', id, row.createdAt);
    }
  }

  for (const [id, row] of after.notes) if (!before.notes.has(id)) await tx.ticketInternalNote.create({ data: row });
  for (const [id, row] of after.feedback) {
    if (before.feedback.has(id)) continue;
    const { attachments, ...feedback } = row;
    await tx.feedback.create({ data: feedback });
    for (const attachment of attachments) {
      await tx.feedbackAttachment.create({ data: { ...attachment, feedbackId: id } });
      await persistConsumption(tx, attachment, row.userId, 'FEEDBACK', id, row.createdAt);
    }
  }
  for (const [id, row] of after.bindings) {
    const previous = before.bindings.get(id);
    if (previous === undefined) await tx.supportUploadBinding.create({ data: row });
    else if (!isDeepStrictEqual(previous, row)) {
      const changed = await tx.supportUploadBinding.updateMany({ where: { id, generation: previous.generation, remoteOperationId: previous.remoteOperationId, fence: previous.fence, status: previous.status, claimToken: previous.claimToken, leaseUntil: previous.leaseUntil }, data: row });
      if (changed.count !== 1) throw new TicketError('SUPPORT_BINDING_CLAIM_CONFLICT');
    }
  }
  for (const [id, row] of after.compensations) {
    const previous = before.compensations.get(id);
    if (previous === undefined) await tx.supportUploadCompensation.create({ data: row });
    else if (!isDeepStrictEqual(previous, row)) {
      const changed = await tx.supportUploadCompensation.updateMany({ where: { id, status: previous.status, claimToken: previous.claimToken, leaseUntil: previous.leaseUntil }, data: row });
      if (changed.count !== 1) throw new TicketError('SUPPORT_COMPENSATION_CLAIM_CONFLICT');
    }
  }
  const existingEvents = new Set(before.outbox.map((row) => row.id));
  for (const event of after.outbox) if (!existingEvents.has(event.id)) await tx.outboxEvent.create({ data: outboxData(event) });
}

async function persistConsumption(tx: PrismaTicketTransactionClient, attachment: { id: string; assetId: string; supportUploadSessionId: string | null }, ownerId: string, sourceType: 'TICKET_MESSAGE' | 'FEEDBACK', sourceId: string, consumedAt: Date): Promise<void> {
  if (attachment.supportUploadSessionId === null) return;
  await tx.supportUploadConsumption.create({ data: { id: attachment.id, sessionId: attachment.supportUploadSessionId, ownerId, assetId: attachment.assetId, sourceType, sourceId, consumedAt } });
}

function outboxData(event: OperationsOutboxEvent): Record<string, unknown> {
  return { ...event, nextAttemptAt: event.createdAt, claimToken: null, leaseUntil: null, lastError: null, publishedAt: null };
}

function mutableData(row: Ticket): Record<string, unknown> { const data = { ...row } as Record<string, unknown>; delete data.id; delete data.userId; delete data.createdAt; return data; }
function addRows<T extends { id: string }>(target: Map<string, T>, rows: T[]): void { for (const row of rows) target.set(row.id, structuredClone(row)); }
function stripMessageId(row: MessageAttachmentRow): { id: string; assetId: string; supportUploadSessionId: string | null } { return { id: row.id, assetId: row.assetId, supportUploadSessionId: row.supportUploadSessionId }; }
function stripFeedbackId(row: FeedbackAttachmentRow): { id: string; assetId: string; supportUploadSessionId: string | null } { return { id: row.id, assetId: row.assetId, supportUploadSessionId: row.supportUploadSessionId }; }
function emptyState(): TicketState { return { tickets: new Map(), messages: new Map(), notes: new Map(), feedback: new Map(), bindings: new Map(), compensations: new Map(), outbox: [] }; }
function cloneState(state: TicketState): TicketState { return { tickets: new Map(structuredClone([...state.tickets])), messages: new Map(structuredClone([...state.messages])), notes: new Map(structuredClone([...state.notes])), feedback: new Map(structuredClone([...state.feedback])), bindings: new Map(structuredClone([...state.bindings])), compensations: new Map(structuredClone([...state.compensations])), outbox: structuredClone(state.outbox) }; }

function mapPrismaError(error: unknown): unknown {
  if (error instanceof TicketError) return error;
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const text = error instanceof Error ? error.message : String(error);
  if (text.includes('TICKET_REVISION_CONFLICT')) return new TicketError('TICKET_REVISION_CONFLICT');
  if (text.includes('TICKET_INVALID_TRANSITION')) return new TicketError('TICKET_INVALID_TRANSITION');
  if (text.includes('TICKET_REPLY_REQUIRED')) return new TicketError('TICKET_REPLY_REQUIRED');
  if (text.includes('TICKET_REOPEN_WINDOW_EXPIRED')) return new TicketError('TICKET_REOPEN_WINDOW_EXPIRED');
  if (code === 'P2002' || code === '23505') {
    const target = typeof error === 'object' && error !== null && 'meta' in error ? JSON.stringify(error.meta) : text;
    if (target.includes('operationId') || target.includes('SupportUploadBinding_operationId')) return new TicketError('IDEMPOTENCY_CONFLICT');
    if (target.includes('SupportUploadConsumption') || target.includes('sessionId')) return new TicketError('SUPPORT_UPLOAD_SESSION_USED');
    return new TicketError('IDEMPOTENCY_CONFLICT');
  }
  return error;
}

function pageWhere(before: { createdAt: Date; id: string } | undefined): Record<string, unknown> {
  return before === undefined ? {} : { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] };
}

type MessageRow = Omit<TicketMessage, 'attachments'>;
type MessageAttachmentRow = { id: string; messageId: string; assetId: string; supportUploadSessionId: string | null };
type FeedbackRow = Omit<Feedback, 'attachments'>;
type FeedbackAttachmentRow = { id: string; feedbackId: string; assetId: string; supportUploadSessionId: string | null };
