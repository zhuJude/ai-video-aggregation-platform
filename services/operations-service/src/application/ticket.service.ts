import { createHash } from 'node:crypto';
import { EventEnvelopeSchema } from '@repo/contracts/common';
import { createUuidV7Generator, isUuidV7 } from '../domain/uuid-v7.js';
import type { OperationRequestContext, OperationsOutboxEvent } from './publication.service.js';

export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type TicketMessageAuthorType = 'USER' | 'AGENT';
export type FeedbackKind = 'MODEL_RESULT' | 'FAILED_TASK' | 'PRODUCT_SUGGESTION';

export class TicketError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'TicketError';
    this.code = code;
  }
}

export interface Ticket {
  id: string;
  userId: string;
  subject: string;
  status: TicketStatus;
  assigneeId: string | null;
  resolutionCycle: number;
  responseRequiredSince: Date;
  revision: number;
  resolvedAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface TicketAttachment {
  id: string;
  assetId: string;
  supportUploadSessionId: string | null;
}

export interface TicketMessage {
  id: string;
  ticketId: string;
  authorId: string;
  authorType: TicketMessageAuthorType;
  resolutionCycle: number;
  body: string;
  idempotencyKey: string | null;
  requestHash: string | null;
  createdAt: Date;
  attachments: TicketAttachment[];
}

export interface TicketInternalNote {
  id: string;
  ticketId: string;
  authorId: string;
  body: string;
  createdAt: Date;
}

export interface Feedback {
  id: string;
  userId: string;
  kind: FeedbackKind;
  taskId: string | null;
  content: string;
  rating: number | null;
  createdAt: Date;
  attachments: TicketAttachment[];
}
export interface SupportUploadBinding {
  id: string;
  operationId: string;
  generation: number;
  remoteOperationId: string;
  fence: string;
  requestHash: string;
  idempotencyKey: string;
  reservationId: string | null;
  ownershipToken: string | null;
  sessionId: string;
  ownerId: string;
  assetId: string;
  sourceType: 'TICKET_MESSAGE' | 'FEEDBACK' | null;
  sourceId: string | null;
  status:
    | 'RESERVING'
    | 'RESERVED'
    | 'FINALIZE_PENDING'
    | 'FINALIZED'
    | 'RELEASE_PENDING'
    | 'RELEASED'
    | 'CANCELLED';
  attempts: number;
  nextAttemptAt: Date;
  claimToken: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  finalizedAt: Date | null;
}
export interface SupportUploadCompensation {
  id: string;
  compensationKey: string;
  reservationId: string;
  operationId: string;
  remoteOperationId: string;
  generation: number;
  fence: string;
  requestHash: string;
  ownershipToken: string;
  sessionId: string;
  ownerId: string;
  assetId: string;
  purpose: string;
  expiresAt: Date;
  status: 'RELEASE_PENDING' | 'RELEASED';
  attempts: number;
  nextAttemptAt: Date;
  claimToken: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  releasedAt: Date | null;
}

export interface AttachmentInput {
  assetId: string;
  supportUploadSessionId?: string;
}
export interface AttachmentReservation {
  id: string;
  operationId: string;
  remoteOperationId: string;
  generation: number;
  fence: string;
  requestHash: string;
  ownershipToken: string;
  sessionId: string;
  assetId: string;
  ownerId: string;
  purpose: string;
  expiresAt: Date;
}
export interface AttachmentAuthorizationPort {
  authorize?(input: {
    assetId: string;
    ownerId: string;
    supportUploadSessionId?: string;
    now: Date;
  }): Promise<void>;
  reserve?(input: {
    operationId: string;
    remoteOperationId: string;
    generation: number;
    fence: string;
    requestHash: string;
    idempotencyKey: string;
    assetId: string;
    ownerId: string;
    supportUploadSessionId?: string;
    now: Date;
  }): Promise<AttachmentReservation | null>;
  finalize?(reservation: AttachmentReservation): Promise<void>;
  release?(reservation: AttachmentReservation): Promise<void>;
  lookup?(operationId: string): Promise<AttachmentReservation | null>;
}
export type SupportUploadSessionOutcome =
  | { outcome: 'USED' }
  | { outcome: 'EXPIRED' }
  | { outcome: 'NOT_FOUND' }
  | { outcome: 'RESERVED'; reservation: AttachmentReservation };
export interface AttachmentAuthorizationGateway {
  findAvailableAsset(assetId: string): Promise<{ id: string; ownerId: string } | null>;
  reserveSupportUploadSession(input: {
    operationId: string;
    remoteOperationId: string;
    generation: number;
    fence: string;
    requestHash: string;
    idempotencyKey: string;
    sessionId: string;
    assetId: string;
    ownerId: string;
    purpose: 'SUPPORT_TICKET';
  }): Promise<SupportUploadSessionOutcome>;
  finalizeSupportUploadSession(input: {
    operationId: string;
    remoteOperationId: string;
    generation: number;
    fence: string;
    requestHash: string;
    ownershipToken: string;
  }): Promise<void>;
  releaseSupportUploadSession(input: {
    operationId: string;
    remoteOperationId: string;
    generation: number;
    fence: string;
    requestHash: string;
    ownershipToken: string;
  }): Promise<void>;
  lookupSupportUploadReservation(operationId: string): Promise<AttachmentReservation | null>;
}

export class SecureAttachmentAuthorization implements AttachmentAuthorizationPort {
  constructor(private readonly gateway: AttachmentAuthorizationGateway) {}

  async reserve(input: {
    operationId: string;
    remoteOperationId: string;
    generation: number;
    fence: string;
    requestHash: string;
    idempotencyKey: string;
    assetId: string;
    ownerId: string;
    supportUploadSessionId?: string;
    now: Date;
  }): Promise<AttachmentReservation | null> {
    const asset = await this.gateway.findAvailableAsset(input.assetId);
    if (asset === null || asset.id !== input.assetId)
      throw new TicketError('ATTACHMENT_NOT_AUTHORIZED');
    if (asset.ownerId === input.ownerId && input.supportUploadSessionId === undefined) return null;
    if (input.supportUploadSessionId === undefined)
      throw new TicketError('ATTACHMENT_NOT_AUTHORIZED');
    const result = await this.gateway.reserveSupportUploadSession({
      operationId: input.operationId,
      remoteOperationId: input.remoteOperationId,
      generation: input.generation,
      fence: input.fence,
      requestHash: input.requestHash,
      idempotencyKey: input.idempotencyKey,
      sessionId: input.supportUploadSessionId,
      assetId: input.assetId,
      ownerId: input.ownerId,
      purpose: 'SUPPORT_TICKET',
    });
    if (result.outcome === 'USED') throw new TicketError('SUPPORT_UPLOAD_SESSION_USED');
    if (result.outcome === 'EXPIRED') throw new TicketError('SUPPORT_UPLOAD_SESSION_EXPIRED');
    if (result.outcome === 'NOT_FOUND') throw new TicketError('ATTACHMENT_NOT_AUTHORIZED');
    return result.reservation;
  }
  finalize(reservation: AttachmentReservation): Promise<void> {
    return this.gateway.finalizeSupportUploadSession({
      operationId: reservation.operationId,
      remoteOperationId: reservation.remoteOperationId,
      generation: reservation.generation,
      fence: reservation.fence,
      requestHash: reservation.requestHash,
      ownershipToken: reservation.ownershipToken,
    });
  }
  release(reservation: AttachmentReservation): Promise<void> {
    return this.gateway.releaseSupportUploadSession({
      operationId: reservation.operationId,
      remoteOperationId: reservation.remoteOperationId,
      generation: reservation.generation,
      fence: reservation.fence,
      requestHash: reservation.requestHash,
      ownershipToken: reservation.ownershipToken,
    });
  }
  lookup(remoteOperationId: string): Promise<AttachmentReservation | null> {
    return this.gateway.lookupSupportUploadReservation(remoteOperationId);
  }
}
export interface FeedbackSubjectAuthorizationPort {
  assertTaskOwned(taskId: string, userId: string): Promise<void>;
}

export interface TicketState {
  tickets: Map<string, Ticket>;
  messages: Map<string, TicketMessage>;
  notes: Map<string, TicketInternalNote>;
  feedback: Map<string, Feedback>;
  bindings: Map<string, SupportUploadBinding>;
  compensations: Map<string, SupportUploadCompensation>;
  outbox: OperationsOutboxEvent[];
}

export type TicketScope =
  | {
      kind: 'ticket';
      ticketId?: string;
      userId?: string;
      page?: RepositoryPage;
      bindingIds?: readonly string[];
    }
  | {
      kind: 'feedback';
      feedbackId?: string;
      userId?: string;
      page?: RepositoryPage;
      bindingIds?: readonly string[];
    }
  | { kind: 'all' };
export interface RepositoryPage {
  limit: number;
  before?: { createdAt: Date; id: string };
}

export interface TicketRepository {
  transact<T>(scope: TicketScope, work: (state: TicketState) => T | Promise<T>): Promise<T>;
  snapshot(scope: TicketScope): Promise<TicketState>;
}

export class InMemoryTicketRepository implements TicketRepository {
  #state = emptyState();
  #tail: Promise<void> = Promise.resolve();

  async transact<T>(scope: TicketScope, work: (state: TicketState) => T | Promise<T>): Promise<T> {
    void scope;
    const previous = this.#tail;
    let release = (): void => undefined;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    const next = cloneState(this.#state);
    try {
      const result = await work(next);
      this.#state = next;
      return structuredClone(result);
    } finally {
      release();
    }
  }

  snapshot(scope: TicketScope): Promise<TicketState> {
    void scope;
    return Promise.resolve(cloneState(this.#state));
  }
  outboxEvents(): OperationsOutboxEvent[] {
    return structuredClone(this.#state.outbox);
  }
}

export class TicketService {
  readonly #repository: TicketRepository;
  readonly #attachmentAuthorization: AttachmentAuthorizationPort;
  readonly #feedbackSubjectAuthorization: FeedbackSubjectAuthorizationPort;
  readonly #now: () => Date;
  readonly #id: () => string;

  constructor(input: {
    repository: TicketRepository;
    attachmentAuthorization: AttachmentAuthorizationPort;
    feedbackSubjectAuthorization: FeedbackSubjectAuthorizationPort;
    now?: () => Date;
    id?: () => string;
  }) {
    this.#repository = input.repository;
    this.#attachmentAuthorization = input.attachmentAuthorization;
    this.#feedbackSubjectAuthorization = input.feedbackSubjectAuthorization;
    this.#now = input.now ?? (() => new Date());
    this.#id = input.id ?? createUuidV7Generator();
  }

  async create(
    input: { subject: string; body: string; attachments?: readonly AttachmentInput[] },
    userId: string,
    context: OperationRequestContext,
  ): Promise<Ticket> {
    assertUuid(userId, 'INVALID_USER_ID');
    const subject = cleanText(input.subject, 200, 'INVALID_TICKET');
    const body = cleanText(input.body, 10_000, 'INVALID_TICKET');
    const attachments = validateAttachments(input.attachments);
    const operationId = this.#id();
    const requestHash = hashValue({ subject, body, attachments });
    const prepared = await this.#reserveAttachments(
      attachments,
      userId,
      operationId,
      operationId,
      requestHash,
    );
    let result: Ticket;
    try {
      result = await this.#repository.transact(
        { kind: 'ticket', userId, bindingIds: bindingIds(prepared) },
        (state) => {
          const now = this.#now();
          const ticket: Ticket = {
            id: this.#id(),
            userId,
            subject,
            status: 'OPEN',
            assigneeId: null,
            resolutionCycle: 0,
            responseRequiredSince: now,
            revision: 0,
            resolvedAt: null,
            closedAt: null,
            createdAt: now,
            updatedAt: now,
          };
          const message = this.#message(
            ticket.id,
            userId,
            'USER',
            ticket.resolutionCycle,
            body,
            null,
            null,
            attachments,
            now,
          );
          state.tickets.set(ticket.id, ticket);
          state.messages.set(message.id, message);
          attachBindings(state, prepared, 'TICKET_MESSAGE', message.id, now);
          addEvent(
            state,
            this.#id(),
            'operations.ticket.created.v1',
            { ticketId: ticket.id, userId, status: ticket.status, messageId: message.id },
            now,
            context,
          );
          return ticket;
        },
      );
    } catch (error) {
      await this.#releaseReservations(prepared);
      throw error;
    }
    await this.#finalizeReservations(prepared);
    return result;
  }

  async get(
    ticketId: string,
    userId: string,
  ): Promise<{ ticket: Ticket; messages: TicketMessage[] }> {
    assertUuid(ticketId, 'TICKET_NOT_FOUND');
    assertUuid(userId, 'INVALID_USER_ID');
    const state = await this.#repository.snapshot({ kind: 'ticket', ticketId, userId });
    const ticket = state.tickets.get(ticketId);
    if (ticket === undefined || ticket.userId !== userId) throw new TicketError('TICKET_NOT_FOUND');
    return { ticket, messages: publicMessages(state, ticketId) };
  }

  async getForAdmin(
    ticketId: string,
  ): Promise<{ ticket: Ticket; messages: TicketMessage[]; internalNotes: TicketInternalNote[] }> {
    assertUuid(ticketId, 'TICKET_NOT_FOUND');
    const state = await this.#repository.snapshot({ kind: 'ticket', ticketId });
    const ticket = state.tickets.get(ticketId);
    if (ticket === undefined) throw new TicketError('TICKET_NOT_FOUND');
    return {
      ticket,
      messages: publicMessages(state, ticketId),
      internalNotes: [...state.notes.values()]
        .filter((note) => note.ticketId === ticketId)
        .sort(byCreated),
    };
  }

  async list(
    userId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: Ticket[]; nextCursor?: string }> {
    assertUuid(userId, 'INVALID_USER_ID');
    const limit = validateLimit(input.limit);
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const state = await this.#repository.snapshot({
      kind: 'ticket',
      userId,
      page: { limit: limit + 1, ...(cursor === undefined ? {} : { before: cursor }) },
    });
    const rows = [...state.tickets.values()]
      .filter(
        (ticket) =>
          ticket.userId === userId && (cursor === undefined || compareCursor(ticket, cursor) < 0),
      )
      .sort(newestFirst);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: encodeCursor(last.createdAt, last.id) }
        : {}),
    };
  }

  addMessage(
    ticketId: string,
    input: { body: string; expectedRevision: number; attachments?: readonly AttachmentInput[] },
    userId: string,
    idempotencyKey: string,
    context: OperationRequestContext,
  ): Promise<{ ticket: Ticket; message: TicketMessage }> {
    return this.#appendPublicMessage(ticketId, input, userId, 'USER', idempotencyKey, context);
  }

  reply(
    ticketId: string,
    input: { body: string; expectedRevision: number; attachments?: readonly AttachmentInput[] },
    adminId: string,
    idempotencyKey: string,
    context: OperationRequestContext,
  ): Promise<{ ticket: Ticket; message: TicketMessage }> {
    return this.#appendPublicMessage(ticketId, input, adminId, 'AGENT', idempotencyKey, context);
  }

  claim(
    ticketId: string,
    expectedRevision: number,
    adminId: string,
    context: OperationRequestContext,
  ): Promise<Ticket> {
    assertUuid(adminId, 'INVALID_ADMIN_ID');
    return this.#mutate(
      ticketId,
      expectedRevision,
      context,
      'operations.ticket.claimed.v1',
      (ticket, now) => {
        if (ticket.status !== 'OPEN') throw new TicketError('TICKET_INVALID_TRANSITION');
        return {
          ...ticket,
          status: 'IN_PROGRESS',
          assigneeId: adminId,
          revision: ticket.revision + 1,
          updatedAt: now,
        };
      },
    );
  }

  reopen(
    ticketId: string,
    expectedRevision: number,
    userId: string,
    context: OperationRequestContext,
  ): Promise<Ticket> {
    assertUuid(userId, 'INVALID_USER_ID');
    return this.#mutate(
      ticketId,
      expectedRevision,
      context,
      'operations.ticket.reopened.v1',
      (ticket, now) => {
        if (ticket.userId !== userId) throw new TicketError('TICKET_NOT_FOUND');
        if (ticket.status !== 'RESOLVED' || ticket.resolvedAt === null)
          throw new TicketError('TICKET_INVALID_TRANSITION');
        if (now.valueOf() > ticket.resolvedAt.valueOf() + 7 * 24 * 60 * 60 * 1000)
          throw new TicketError('TICKET_REOPEN_WINDOW_EXPIRED');
        return {
          ...ticket,
          status: 'IN_PROGRESS',
          resolutionCycle: ticket.resolutionCycle + 1,
          responseRequiredSince: now,
          revision: ticket.revision + 1,
          resolvedAt: null,
          closedAt: null,
          updatedAt: now,
        };
      },
    );
  }

  resolve(
    ticketId: string,
    expectedRevision: number,
    adminId: string,
    context: OperationRequestContext,
  ): Promise<Ticket> {
    assertUuid(adminId, 'INVALID_ADMIN_ID');
    return this.#mutate(
      ticketId,
      expectedRevision,
      context,
      'operations.ticket.resolved.v1',
      (ticket, now, state) => {
        if (ticket.status !== 'IN_PROGRESS' || ticket.assigneeId !== adminId)
          throw new TicketError('TICKET_INVALID_TRANSITION');
        if (
          ![...state.messages.values()].some(
            (message) =>
              message.ticketId === ticket.id &&
              message.authorType === 'AGENT' &&
              message.resolutionCycle === ticket.resolutionCycle &&
              message.createdAt >= ticket.responseRequiredSince,
          )
        )
          throw new TicketError('TICKET_REPLY_REQUIRED');
        return {
          ...ticket,
          status: 'RESOLVED',
          revision: ticket.revision + 1,
          resolvedAt: now,
          updatedAt: now,
        };
      },
    );
  }

  close(
    ticketId: string,
    expectedRevision: number,
    adminId: string,
    context: OperationRequestContext,
  ): Promise<Ticket> {
    assertUuid(adminId, 'INVALID_ADMIN_ID');
    return this.#mutate(
      ticketId,
      expectedRevision,
      context,
      'operations.ticket.closed.v1',
      (ticket, now) => {
        if (ticket.status !== 'RESOLVED') throw new TicketError('TICKET_INVALID_TRANSITION');
        return {
          ...ticket,
          status: 'CLOSED',
          revision: ticket.revision + 1,
          closedAt: now,
          updatedAt: now,
        };
      },
    );
  }

  addInternalNote(
    ticketId: string,
    input: { body: string; expectedRevision: number },
    adminId: string,
  ): Promise<{ ticket: Ticket; note: TicketInternalNote }> {
    assertUuid(adminId, 'INVALID_ADMIN_ID');
    const body = cleanText(input.body, 10_000, 'INVALID_TICKET_NOTE');
    return this.#repository.transact({ kind: 'ticket', ticketId }, (state) => {
      const ticket = requiredTicket(state, ticketId);
      guardRevision(ticket, input.expectedRevision);
      const now = this.#now();
      const updated = { ...ticket, revision: ticket.revision + 1, updatedAt: now };
      const note = { id: this.#id(), ticketId, authorId: adminId, body, createdAt: now };
      state.tickets.set(ticketId, updated);
      state.notes.set(note.id, note);
      return { ticket: updated, note };
    });
  }

  async createFeedback(
    input: {
      kind: FeedbackKind;
      taskId?: string;
      content: string;
      rating?: number;
      attachments?: readonly AttachmentInput[];
    },
    userId: string,
    context: OperationRequestContext,
  ): Promise<Feedback> {
    assertUuid(userId, 'INVALID_USER_ID');
    validateFeedback(input);
    const content = cleanText(input.content, 5_000, 'INVALID_FEEDBACK');
    if (input.taskId !== undefined)
      await this.#feedbackSubjectAuthorization.assertTaskOwned(input.taskId, userId);
    const attachments = validateAttachments(input.attachments);
    const operationId = this.#id();
    const requestHash = hashValue({
      kind: input.kind,
      taskId: input.taskId ?? null,
      content,
      rating: input.rating ?? null,
      attachments,
    });
    const prepared = await this.#reserveAttachments(
      attachments,
      userId,
      operationId,
      operationId,
      requestHash,
    );
    let result: Feedback;
    try {
      result = await this.#repository.transact(
        { kind: 'feedback', userId, bindingIds: bindingIds(prepared) },
        (state) => {
          const now = this.#now();
          const feedback: Feedback = {
            id: this.#id(),
            userId,
            kind: input.kind,
            taskId: input.taskId ?? null,
            content,
            rating: input.rating ?? null,
            createdAt: now,
            attachments: attachments.map((item) => ({
              id: this.#id(),
              assetId: item.assetId,
              supportUploadSessionId: item.supportUploadSessionId ?? null,
            })),
          };
          state.feedback.set(feedback.id, feedback);
          attachBindings(state, prepared, 'FEEDBACK', feedback.id, now);
          addEvent(
            state,
            this.#id(),
            'operations.feedback.created.v1',
            {
              feedbackId: feedback.id,
              userId,
              kind: feedback.kind,
              taskId: feedback.taskId,
              rating: feedback.rating,
            },
            now,
            context,
          );
          return feedback;
        },
      );
    } catch (error) {
      await this.#releaseReservations(prepared);
      throw error;
    }
    await this.#finalizeReservations(prepared);
    return result;
  }

  async getFeedback(feedbackId: string, userId: string): Promise<Feedback> {
    assertUuid(feedbackId, 'FEEDBACK_NOT_FOUND');
    assertUuid(userId, 'INVALID_USER_ID');
    const feedback = (
      await this.#repository.snapshot({ kind: 'feedback', feedbackId, userId })
    ).feedback.get(feedbackId);
    if (feedback === undefined || feedback.userId !== userId)
      throw new TicketError('FEEDBACK_NOT_FOUND');
    return feedback;
  }

  async listFeedback(
    userId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: Feedback[]; nextCursor?: string }> {
    assertUuid(userId, 'INVALID_USER_ID');
    const limit = validateLimit(input.limit);
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const state = await this.#repository.snapshot({
      kind: 'feedback',
      userId,
      page: { limit: limit + 1, ...(cursor === undefined ? {} : { before: cursor }) },
    });
    const rows = [...state.feedback.values()]
      .filter(
        (row) =>
          row.userId === userId && (cursor === undefined || compareCreatedCursor(row, cursor) < 0),
      )
      .sort(newestCreatedFirst);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: encodeCursor(last.createdAt, last.id) }
        : {}),
    };
  }

  async listFeedbackForAdmin(input: {
    limit: number;
    cursor?: string;
  }): Promise<{ items: Feedback[]; nextCursor?: string }> {
    const limit = validateLimit(input.limit);
    const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const state = await this.#repository.snapshot({
      kind: 'feedback',
      page: { limit: limit + 1, ...(cursor === undefined ? {} : { before: cursor }) },
    });
    const rows = [...state.feedback.values()]
      .filter((row) => cursor === undefined || compareCreatedCursor(row, cursor) < 0)
      .sort(newestCreatedFirst);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > limit && last !== undefined
        ? { nextCursor: encodeCursor(last.createdAt, last.id) }
        : {}),
    };
  }

  async #appendPublicMessage(
    ticketId: string,
    input: { body: string; expectedRevision: number; attachments?: readonly AttachmentInput[] },
    actorId: string,
    authorType: TicketMessageAuthorType,
    idempotencyKey: string,
    context: OperationRequestContext,
  ): Promise<{ ticket: Ticket; message: TicketMessage }> {
    assertUuid(actorId, authorType === 'USER' ? 'INVALID_USER_ID' : 'INVALID_ADMIN_ID');
    assertIdempotencyKey(idempotencyKey);
    const body = cleanText(input.body, 10_000, 'INVALID_TICKET_MESSAGE');
    const attachments = validateAttachments(input.attachments);
    const requestHash = hashRequest(body, attachments);
    const scope: TicketScope = {
      kind: 'ticket',
      ticketId,
      ...(authorType === 'USER' ? { userId: actorId } : {}),
    };
    const prior = await this.#repository.snapshot(scope);
    const priorMessage = [...prior.messages.values()].find(
      (message) =>
        message.ticketId === ticketId &&
        message.authorId === actorId &&
        message.idempotencyKey === idempotencyKey,
    );
    if (priorMessage !== undefined) {
      if (priorMessage.requestHash !== requestHash) throw new TicketError('IDEMPOTENCY_CONFLICT');
      return { ticket: requiredTicket(prior, ticketId), message: priorMessage };
    }
    const operationId = createHash('sha256')
      .update(`${ticketId}:${actorId}:${idempotencyKey}`)
      .digest('hex');
    const ownerId = requiredTicket(prior, ticketId).userId;
    let prepared: PreparedAttachment[];
    try {
      prepared = await this.#reserveAttachments(
        attachments,
        ownerId,
        operationId,
        idempotencyKey,
        requestHash,
      );
    } catch (error) {
      if (error instanceof SupportUploadRequestConflict) throw error;
      if (
        error instanceof SupportUploadIntentExists ||
        error instanceof StaleSupportUploadGeneration ||
        (error instanceof TicketError &&
          ['IDEMPOTENCY_CONFLICT', 'SUPPORT_BINDING_CLAIM_CONFLICT'].includes(error.code))
      )
        return this.#waitForMessageWinner(scope, ticketId, actorId, idempotencyKey, requestHash);
      throw error;
    }
    let result: { ticket: Ticket; message: TicketMessage };
    try {
      result = await this.#repository.transact(
        { ...scope, bindingIds: bindingIds(prepared) },
        (state) => {
          const existing = [...state.messages.values()].find(
            (message) =>
              message.ticketId === ticketId &&
              message.authorId === actorId &&
              message.idempotencyKey === idempotencyKey,
          );
          if (existing !== undefined) {
            if (existing.requestHash !== requestHash) throw new TicketError('IDEMPOTENCY_CONFLICT');
            return { ticket: requiredTicket(state, ticketId), message: existing };
          }
          const ticket = requiredTicket(state, ticketId);
          if (authorType === 'USER' && ticket.userId !== actorId)
            throw new TicketError('TICKET_NOT_FOUND');
          guardRevision(ticket, input.expectedRevision);
          if (ticket.status !== 'OPEN' && ticket.status !== 'IN_PROGRESS')
            throw new TicketError('TICKET_INVALID_TRANSITION');
          if (
            authorType === 'AGENT' &&
            (ticket.status !== 'IN_PROGRESS' || ticket.assigneeId !== actorId)
          )
            throw new TicketError('TICKET_INVALID_TRANSITION');
          const now = this.#now();
          const updated = { ...ticket, revision: ticket.revision + 1, updatedAt: now };
          const message = this.#message(
            ticketId,
            actorId,
            authorType,
            ticket.resolutionCycle,
            body,
            idempotencyKey,
            requestHash,
            attachments,
            now,
          );
          state.tickets.set(ticketId, updated);
          state.messages.set(message.id, message);
          attachBindings(state, prepared, 'TICKET_MESSAGE', message.id, now);
          addEvent(
            state,
            this.#id(),
            'operations.ticket.message-added.v1',
            {
              ticketId,
              messageId: message.id,
              userId: ticket.userId,
              authorType,
              status: ticket.status,
            },
            now,
            context,
          );
          return { ticket: updated, message };
        },
      );
    } catch (error) {
      const code = error instanceof TicketError ? error.code : '';
      if (code !== 'TICKET_REVISION_CONFLICT' && code !== 'IDEMPOTENCY_CONFLICT') {
        await this.#releaseReservations(prepared);
        throw error;
      }
      const state = await this.#repository.snapshot(scope);
      const existing = [...state.messages.values()].find(
        (message) =>
          message.ticketId === ticketId &&
          message.authorId === actorId &&
          message.idempotencyKey === idempotencyKey,
      );
      if (existing === undefined) {
        await this.#releaseReservations(prepared);
        throw error;
      }
      if (existing.requestHash !== requestHash) {
        await this.#releaseReservations(prepared);
        throw new TicketError('IDEMPOTENCY_CONFLICT');
      }
      await this.#finalizeReservations(prepared);
      return { ticket: requiredTicket(state, ticketId), message: existing };
    }
    await this.#finalizeReservations(prepared);
    return result;
  }

  #message(
    ticketId: string,
    authorId: string,
    authorType: TicketMessageAuthorType,
    resolutionCycle: number,
    body: string,
    idempotencyKey: string | null,
    requestHash: string | null,
    attachments: readonly AttachmentInput[],
    createdAt: Date,
  ): TicketMessage {
    return {
      id: this.#id(),
      ticketId,
      authorId,
      authorType,
      resolutionCycle,
      body,
      idempotencyKey,
      requestHash,
      createdAt,
      attachments: attachments.map((item) => ({
        id: this.#id(),
        assetId: item.assetId,
        supportUploadSessionId: item.supportUploadSessionId ?? null,
      })),
    };
  }

  #mutate(
    ticketId: string,
    expectedRevision: number,
    context: OperationRequestContext,
    eventType: string,
    transition: (ticket: Ticket, now: Date, state: TicketState) => Ticket,
  ): Promise<Ticket> {
    return this.#repository.transact({ kind: 'ticket', ticketId }, (state) => {
      const ticket = requiredTicket(state, ticketId);
      guardRevision(ticket, expectedRevision);
      const now = this.#now();
      const updated = transition(ticket, now, state);
      state.tickets.set(ticketId, updated);
      addEvent(
        state,
        this.#id(),
        eventType,
        {
          ticketId,
          userId: ticket.userId,
          previousStatus: ticket.status,
          status: updated.status,
          revision: updated.revision,
        },
        now,
        context,
      );
      return updated;
    });
  }

  async #reserveAttachments(
    attachments: readonly AttachmentInput[],
    ownerId: string,
    operationId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<PreparedAttachment[]> {
    const prepared: PreparedAttachment[] = [];
    try {
      for (const attachment of attachments) {
        const attachmentOperationId = `${operationId}:${attachment.assetId}`;
        if (
          attachment.supportUploadSessionId !== undefined &&
          this.#attachmentAuthorization.reserve !== undefined
        ) {
          const now = this.#now();
          const binding = await this.#beginSupportUploadIntent({
            operationId: attachmentOperationId,
            requestHash,
            idempotencyKey,
            sessionId: attachment.supportUploadSessionId,
            ownerId,
            assetId: attachment.assetId,
            now,
          });
          const item: PreparedAttachment = {
            attachment,
            bindingId: binding.id,
            generation: binding.generation,
            remoteOperationId: binding.remoteOperationId,
            fence: binding.fence,
            identityValidated: false,
            reservation: null,
          };
          prepared.push(item);
          await this.#assertCurrentGeneration(item, 'RESERVING');
          const reservation = await this.#attachmentAuthorization.reserve({
            ...attachment,
            ownerId,
            operationId: attachmentOperationId,
            remoteOperationId: binding.remoteOperationId,
            generation: binding.generation,
            fence: binding.fence,
            requestHash,
            idempotencyKey,
            now,
          });
          if (reservation === null) throw new TicketError('ATTACHMENT_NOT_AUTHORIZED');
          item.reservation = reservation;
          const identityError = reservationIdentityError(reservation, binding);
          if (identityError !== null) throw identityError;
          item.identityValidated = true;
          await this.#repository.transact({ kind: 'all' }, (state) => {
            const current = requiredBinding(state, binding.id);
            if (
              current.status !== 'RESERVING' ||
              current.claimToken !== binding.fence ||
              !matchesGeneration(current, item)
            )
              throw new StaleSupportUploadGeneration();
            state.bindings.set(binding.id, {
              ...current,
              reservationId: reservation.id,
              ownershipToken: reservation.ownershipToken,
              status: 'RESERVED',
              nextAttemptAt: new Date(now.valueOf() + 30_000),
              leaseUntil: new Date(now.valueOf() + 30_000),
            });
          });
          const validationError = reservationError(reservation, {
            operationId: attachmentOperationId,
            remoteOperationId: binding.remoteOperationId,
            generation: binding.generation,
            fence: binding.fence,
            requestHash,
            sessionId: attachment.supportUploadSessionId,
            assetId: attachment.assetId,
            ownerId,
            now,
          });
          if (validationError !== null) throw validationError;
        } else if (this.#attachmentAuthorization.reserve !== undefined) {
          const reservation = await this.#attachmentAuthorization.reserve({
            ...attachment,
            ownerId,
            operationId: attachmentOperationId,
            remoteOperationId: this.#id(),
            generation: 0,
            fence: this.#id(),
            requestHash,
            idempotencyKey,
            now: this.#now(),
          });
          if (reservation !== null) throw new TicketError('ATTACHMENT_NOT_AUTHORIZED');
          prepared.push({
            attachment,
            bindingId: null,
            generation: null,
            remoteOperationId: null,
            fence: null,
            identityValidated: true,
            reservation: null,
          });
        } else {
          await this.#attachmentAuthorization.authorize?.({
            ...attachment,
            ownerId,
            now: this.#now(),
          });
          prepared.push({
            attachment,
            bindingId: null,
            generation: null,
            remoteOperationId: null,
            fence: null,
            identityValidated: true,
            reservation: null,
          });
        }
      }
      return prepared;
    } catch (error) {
      await this.#releaseReservations(prepared);
      throw error;
    }
  }

  #beginSupportUploadIntent(input: {
    operationId: string;
    requestHash: string;
    idempotencyKey: string;
    sessionId: string;
    ownerId: string;
    assetId: string;
    now: Date;
  }): Promise<SupportUploadBinding> {
    return this.#repository.transact({ kind: 'all' }, (state) => {
      const existing = [...state.bindings.values()].find(
        (binding) => binding.operationId === input.operationId,
      );
      const remoteOperationId = this.#id();
      const fence = this.#id();
      const leaseUntil = new Date(input.now.valueOf() + 30_000);
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash) throw new SupportUploadRequestConflict();
        if (existing.status !== 'RELEASED' && existing.status !== 'CANCELLED')
          throw new SupportUploadIntentExists();
        const rearmed: SupportUploadBinding = {
          ...existing,
          generation: existing.generation + 1,
          remoteOperationId,
          fence,
          reservationId: null,
          ownershipToken: null,
          sourceType: null,
          sourceId: null,
          status: 'RESERVING',
          attempts: 0,
          nextAttemptAt: leaseUntil,
          claimToken: fence,
          leaseUntil,
          lastError: null,
          finalizedAt: null,
        };
        state.bindings.set(existing.id, rearmed);
        return rearmed;
      }
      const id = this.#id();
      const intent: SupportUploadBinding = {
        id,
        operationId: input.operationId,
        generation: 0,
        remoteOperationId,
        fence,
        requestHash: input.requestHash,
        idempotencyKey: input.idempotencyKey,
        reservationId: null,
        ownershipToken: null,
        sessionId: input.sessionId,
        ownerId: input.ownerId,
        assetId: input.assetId,
        sourceType: null,
        sourceId: null,
        status: 'RESERVING',
        attempts: 0,
        nextAttemptAt: leaseUntil,
        claimToken: fence,
        leaseUntil,
        lastError: null,
        createdAt: input.now,
        finalizedAt: null,
      };
      state.bindings.set(id, intent);
      return intent;
    });
  }

  #assertCurrentGeneration(
    item: PreparedAttachment,
    expectedStatus: SupportUploadBinding['status'],
  ): Promise<void> {
    return this.#repository.transact({ kind: 'all' }, (state) => {
      if (item.bindingId === null || item.fence === null) return;
      const current = requiredBinding(state, item.bindingId);
      if (
        current.status !== expectedStatus ||
        current.claimToken !== item.fence ||
        !matchesGeneration(current, item)
      )
        throw new StaleSupportUploadGeneration();
      const leaseUntil = new Date(this.#now().valueOf() + 30_000);
      state.bindings.set(current.id, { ...current, nextAttemptAt: leaseUntil, leaseUntil });
    });
  }

  async #finalizeReservations(prepared: readonly PreparedAttachment[]): Promise<void> {
    for (const item of prepared) {
      if (
        item.bindingId === null ||
        item.reservation === null ||
        this.#attachmentAuthorization.finalize === undefined
      )
        continue;
      try {
        await this.#attachmentAuthorization.finalize(item.reservation);
        await this.#repository.transact({ kind: 'all' }, (state) => {
          const binding = requiredBinding(state, item.bindingId as string);
          if (
            binding.status === 'FINALIZE_PENDING' &&
            matchesGeneration(binding, item) &&
            ownsReservation(binding, item.reservation as AttachmentReservation)
          )
            state.bindings.set(binding.id, {
              ...binding,
              status: 'FINALIZED',
              finalizedAt: this.#now(),
              claimToken: null,
              leaseUntil: null,
              lastError: null,
            });
        });
      } catch {
        await this.#recordSagaFailure(item, 'FINALIZE_FAILED');
      }
    }
  }

  async #releaseReservations(prepared: readonly PreparedAttachment[]): Promise<void> {
    for (const item of prepared) {
      if (item.bindingId === null) continue;
      if (item.reservation !== null && !item.identityValidated) {
        const compensation = await this.#enqueueCompensation(item.reservation);
        await this.#cancelPreparedGeneration(item);
        await this.#releaseCompensation(compensation);
        continue;
      }
      const generationIsCurrent = await this.#repository.transact({ kind: 'all' }, (state) => {
        const binding = state.bindings.get(item.bindingId as string);
        if (binding === undefined || !matchesGeneration(binding, item)) return false;
        if (
          binding.status === 'RELEASED' ||
          binding.status === 'CANCELLED' ||
          binding.status === 'FINALIZED'
        )
          return false;
        state.bindings.set(binding.id, {
          ...binding,
          reservationId: item.reservation?.id ?? binding.reservationId,
          ownershipToken: item.reservation?.ownershipToken ?? binding.ownershipToken,
          sourceType: null,
          sourceId: null,
          status: 'RELEASE_PENDING',
          nextAttemptAt: this.#now(),
          claimToken: null,
          leaseUntil: null,
        });
        return true;
      });
      if (!generationIsCurrent) {
        if (item.reservation !== null) await this.#releaseStaleReservation(item.reservation);
        continue;
      }
      if (item.reservation === null || this.#attachmentAuthorization.release === undefined) {
        await this.#markReleasedWithoutRemoteReservation(item);
        continue;
      }
      try {
        await this.#attachmentAuthorization.release(item.reservation);
        await this.#repository.transact({ kind: 'all' }, (state) => {
          const binding = state.bindings.get(item.bindingId as string);
          if (
            binding?.status === 'RELEASE_PENDING' &&
            matchesGeneration(binding, item) &&
            ownsReservation(binding, item.reservation as AttachmentReservation)
          )
            state.bindings.set(binding.id, {
              ...binding,
              status: 'RELEASED',
              claimToken: null,
              leaseUntil: null,
              lastError: null,
            });
        });
      } catch {
        await this.#recordSagaFailure(item, 'RELEASE_FAILED');
      }
    }
  }

  async retryPendingAttachmentFinalizations(limit = 50): Promise<number> {
    const snapshot = await this.#repository.snapshot({ kind: 'all' });
    const now = this.#now();
    const due = [...snapshot.bindings.values()]
      .filter(
        (binding) =>
          ['RESERVING', 'RESERVED', 'FINALIZE_PENDING', 'RELEASE_PENDING'].includes(
            binding.status,
          ) &&
          binding.nextAttemptAt <= now &&
          (binding.leaseUntil === null || binding.leaseUntil <= now),
      )
      .slice(0, limit);
    for (const binding of due) {
      const claimToken = this.#id();
      let claimed = false;
      try {
        claimed = await this.#repository.transact({ kind: 'all' }, (state) => {
          const current = state.bindings.get(binding.id);
          if (
            current === undefined ||
            !sameGeneration(current, binding) ||
            current.status !== binding.status ||
            current.nextAttemptAt > now ||
            (current.leaseUntil !== null && current.leaseUntil > now)
          )
            return false;
          state.bindings.set(binding.id, {
            ...current,
            attempts: current.attempts + 1,
            claimToken,
            leaseUntil: new Date(now.valueOf() + 30_000),
            nextAttemptAt: new Date(
              now.valueOf() + Math.min(300_000, 2 ** current.attempts * 1_000),
            ),
          });
          return true;
        });
      } catch (error) {
        if (!(error instanceof TicketError) || error.code !== 'SUPPORT_BINDING_CLAIM_CONFLICT')
          throw error;
      }
      if (!claimed) continue;
      try {
        let reservation: AttachmentReservation | null;
        if (binding.status === 'RESERVING') {
          if (this.#attachmentAuthorization.reserve === undefined)
            throw new Error('reserve unavailable');
          reservation = await this.#attachmentAuthorization.reserve({
            operationId: binding.operationId,
            remoteOperationId: binding.remoteOperationId,
            generation: binding.generation,
            fence: binding.fence,
            requestHash: binding.requestHash,
            idempotencyKey: binding.idempotencyKey,
            assetId: binding.assetId,
            ownerId: binding.ownerId,
            supportUploadSessionId: binding.sessionId,
            now,
          });
          if (reservation === null) throw new TicketError('ATTACHMENT_NOT_AUTHORIZED');
          const identityError = reservationIdentityError(reservation, binding);
          if (identityError !== null) {
            const compensation = await this.#enqueueCompensation(reservation);
            await this.#repository.transact({ kind: 'all' }, (state) => {
              const current = state.bindings.get(binding.id);
              if (
                current?.claimToken === claimToken &&
                sameGeneration(current, binding) &&
                current.status === 'RESERVING'
              )
                state.bindings.set(binding.id, {
                  ...current,
                  status: 'CANCELLED',
                  claimToken: null,
                  leaseUntil: null,
                  lastError: null,
                });
            });
            await this.#releaseCompensation(compensation);
            continue;
          }
          await this.#repository.transact({ kind: 'all' }, (state) => {
            const current = state.bindings.get(binding.id);
            if (
              current?.claimToken !== claimToken ||
              !sameGeneration(current, binding) ||
              current.status !== 'RESERVING'
            )
              throw new StaleSupportUploadGeneration();
            state.bindings.set(binding.id, {
              ...current,
              reservationId: reservation?.id ?? null,
              ownershipToken: reservation?.ownershipToken ?? null,
              status: 'RELEASE_PENDING',
            });
          });
        } else {
          reservation = reservationFromBinding(binding);
          if (reservation === null) throw new Error('reservation unavailable');
        }
        if (binding.status === 'FINALIZE_PENDING') {
          if (this.#attachmentAuthorization.finalize === undefined)
            throw new Error('finalize unavailable');
          await this.#attachmentAuthorization.finalize(reservation);
        } else {
          if (this.#attachmentAuthorization.release === undefined)
            throw new Error('release unavailable');
          await this.#attachmentAuthorization.release(reservation);
        }
        await this.#repository.transact({ kind: 'all' }, (state) => {
          const current = state.bindings.get(binding.id);
          if (current?.claimToken === claimToken && sameGeneration(current, binding))
            state.bindings.set(binding.id, {
              ...current,
              status: binding.status === 'FINALIZE_PENDING' ? 'FINALIZED' : 'RELEASED',
              finalizedAt:
                binding.status === 'FINALIZE_PENDING' ? this.#now() : current.finalizedAt,
              claimToken: null,
              leaseUntil: null,
              lastError: null,
            });
        });
      } catch (error) {
        await this.#repository.transact({ kind: 'all' }, (state) => {
          const current = state.bindings.get(binding.id);
          if (current?.claimToken !== claimToken || !sameGeneration(current, binding)) return;
          const terminal =
            binding.status === 'RESERVING' &&
            error instanceof TicketError &&
            [
              'ATTACHMENT_NOT_AUTHORIZED',
              'SUPPORT_UPLOAD_SESSION_EXPIRED',
              'SUPPORT_UPLOAD_SESSION_USED',
            ].includes(error.code);
          state.bindings.set(binding.id, {
            ...current,
            status: terminal ? 'CANCELLED' : current.status,
            claimToken: null,
            leaseUntil: null,
            lastError: terminal
              ? null
              : current.status === 'RESERVING'
                ? 'RESERVE_FAILED'
                : current.status === 'FINALIZE_PENDING'
                  ? 'FINALIZE_FAILED'
                  : 'RELEASE_FAILED',
          });
        });
      }
    }
    const compensationDue = [...snapshot.compensations.values()]
      .filter(
        (row) =>
          row.status === 'RELEASE_PENDING' &&
          row.nextAttemptAt <= now &&
          (row.leaseUntil === null || row.leaseUntil <= now),
      )
      .slice(0, limit);
    for (const compensation of compensationDue) {
      const claimToken = this.#id();
      let claimed = false;
      try {
        claimed = await this.#repository.transact({ kind: 'all' }, (state) => {
          const current = state.compensations.get(compensation.id);
          if (
            current === undefined ||
            current.status !== 'RELEASE_PENDING' ||
            current.nextAttemptAt > now ||
            (current.leaseUntil !== null && current.leaseUntil > now)
          )
            return false;
          state.compensations.set(current.id, {
            ...current,
            attempts: current.attempts + 1,
            claimToken,
            leaseUntil: new Date(now.valueOf() + 30_000),
            nextAttemptAt: new Date(
              now.valueOf() + Math.min(300_000, 2 ** current.attempts * 1_000),
            ),
          });
          return true;
        });
      } catch (error) {
        if (!(error instanceof TicketError) || error.code !== 'SUPPORT_COMPENSATION_CLAIM_CONFLICT')
          throw error;
      }
      if (!claimed) continue;
      try {
        if (this.#attachmentAuthorization.release === undefined)
          throw new Error('release unavailable');
        await this.#attachmentAuthorization.release(compensationReservation(compensation));
        await this.#repository.transact({ kind: 'all' }, (state) => {
          const current = state.compensations.get(compensation.id);
          if (current?.claimToken === claimToken)
            state.compensations.set(current.id, {
              ...current,
              status: 'RELEASED',
              claimToken: null,
              leaseUntil: null,
              lastError: null,
              releasedAt: this.#now(),
            });
        });
      } catch {
        await this.#repository.transact({ kind: 'all' }, (state) => {
          const current = state.compensations.get(compensation.id);
          if (current?.claimToken === claimToken)
            state.compensations.set(current.id, {
              ...current,
              claimToken: null,
              leaseUntil: null,
              lastError: 'RELEASE_FAILED',
            });
        });
      }
    }
    return due.length + compensationDue.length;
  }

  async #recordSagaFailure(
    item: PreparedAttachment,
    code: 'FINALIZE_FAILED' | 'RELEASE_FAILED',
  ): Promise<void> {
    if (item.bindingId === null) return;
    await this.#repository.transact({ kind: 'all' }, (state) => {
      const binding = state.bindings.get(item.bindingId as string);
      if (binding !== undefined && matchesGeneration(binding, item)) {
        const attempts = binding.attempts + 1;
        const now = this.#now();
        state.bindings.set(binding.id, {
          ...binding,
          attempts,
          nextAttemptAt: new Date(now.valueOf() + Math.min(300_000, 2 ** (attempts - 1) * 1_000)),
          claimToken: null,
          leaseUntil: null,
          lastError: code,
        });
      }
    });
  }

  async #markReleasedWithoutRemoteReservation(item: PreparedAttachment): Promise<void> {
    await this.#repository.transact({ kind: 'all' }, (state) => {
      const binding = state.bindings.get(item.bindingId as string);
      if (
        binding?.status === 'RELEASE_PENDING' &&
        binding.ownershipToken === null &&
        matchesGeneration(binding, item)
      )
        state.bindings.set(binding.id, { ...binding, status: 'RELEASED', lastError: null });
    });
  }

  async #releaseStaleReservation(reservation: AttachmentReservation): Promise<void> {
    await this.#releaseCompensation(await this.#enqueueCompensation(reservation));
  }

  #enqueueCompensation(reservation: AttachmentReservation): Promise<SupportUploadCompensation> {
    return this.#repository.transact({ kind: 'all' }, (state) => {
      const compensationKey = hashValue({
        reservationId: reservation.id,
        operationId: reservation.operationId,
        remoteOperationId: reservation.remoteOperationId,
        generation: reservation.generation,
        fence: reservation.fence,
        requestHash: reservation.requestHash,
        ownershipToken: reservation.ownershipToken,
        sessionId: reservation.sessionId,
        ownerId: reservation.ownerId,
        assetId: reservation.assetId,
        purpose: reservation.purpose,
        expiresAt: reservation.expiresAt,
      });
      const existing = [...state.compensations.values()].find(
        (row) => row.compensationKey === compensationKey,
      );
      if (existing !== undefined) return existing;
      const now = this.#now();
      const id = this.#id();
      const row: SupportUploadCompensation = {
        id,
        compensationKey,
        reservationId: reservation.id,
        operationId: reservation.operationId,
        remoteOperationId: reservation.remoteOperationId,
        generation: reservation.generation,
        fence: reservation.fence,
        requestHash: reservation.requestHash,
        ownershipToken: reservation.ownershipToken,
        sessionId: reservation.sessionId,
        ownerId: reservation.ownerId,
        assetId: reservation.assetId,
        purpose: reservation.purpose,
        expiresAt: reservation.expiresAt,
        status: 'RELEASE_PENDING',
        attempts: 0,
        nextAttemptAt: now,
        claimToken: null,
        leaseUntil: null,
        lastError: null,
        createdAt: now,
        releasedAt: null,
      };
      state.compensations.set(id, row);
      return row;
    });
  }

  async #cancelPreparedGeneration(item: PreparedAttachment): Promise<void> {
    if (item.bindingId === null) return;
    await this.#repository.transact({ kind: 'all' }, (state) => {
      const binding = state.bindings.get(item.bindingId as string);
      if (
        binding !== undefined &&
        binding.status === 'RESERVING' &&
        matchesGeneration(binding, item)
      )
        state.bindings.set(binding.id, {
          ...binding,
          status: 'CANCELLED',
          claimToken: null,
          leaseUntil: null,
          lastError: null,
        });
    });
  }

  async #releaseCompensation(compensation: SupportUploadCompensation): Promise<void> {
    if (compensation.status === 'RELEASED' || this.#attachmentAuthorization.release === undefined)
      return;
    try {
      await this.#attachmentAuthorization.release(compensationReservation(compensation));
      await this.#repository.transact({ kind: 'all' }, (state) => {
        const current = state.compensations.get(compensation.id);
        if (current?.status === 'RELEASE_PENDING')
          state.compensations.set(current.id, {
            ...current,
            status: 'RELEASED',
            claimToken: null,
            leaseUntil: null,
            lastError: null,
            releasedAt: this.#now(),
          });
      });
    } catch {
      await this.#repository.transact({ kind: 'all' }, (state) => {
        const current = state.compensations.get(compensation.id);
        if (current?.status !== 'RELEASE_PENDING') return;
        const attempts = current.attempts + 1;
        const now = this.#now();
        state.compensations.set(current.id, {
          ...current,
          attempts,
          nextAttemptAt: new Date(now.valueOf() + Math.min(300_000, 2 ** (attempts - 1) * 1_000)),
          claimToken: null,
          leaseUntil: null,
          lastError: 'RELEASE_FAILED',
        });
      });
    }
  }

  async #waitForMessageWinner(
    scope: TicketScope,
    ticketId: string,
    actorId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<{ ticket: Ticket; message: TicketMessage }> {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const state = await this.#repository.snapshot(scope);
      const winner = [...state.messages.values()].find(
        (message) =>
          message.ticketId === ticketId &&
          message.authorId === actorId &&
          message.idempotencyKey === idempotencyKey,
      );
      if (winner !== undefined) {
        if (winner.requestHash !== requestHash) throw new TicketError('IDEMPOTENCY_CONFLICT');
        return { ticket: requiredTicket(state, ticketId), message: winner };
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    throw new TicketError('IDEMPOTENCY_CONFLICT');
  }
}

interface PreparedAttachment {
  attachment: AttachmentInput;
  bindingId: string | null;
  generation: number | null;
  remoteOperationId: string | null;
  fence: string | null;
  identityValidated: boolean;
  reservation: AttachmentReservation | null;
}
class SupportUploadIntentExists extends Error {
  constructor() {
    super('support upload intent exists');
  }
}
class SupportUploadRequestConflict extends TicketError {
  constructor() {
    super('IDEMPOTENCY_CONFLICT');
  }
}
class StaleSupportUploadGeneration extends Error {
  constructor() {
    super('stale support upload generation');
  }
}

function attachBindings(
  state: TicketState,
  prepared: readonly PreparedAttachment[],
  sourceType: 'TICKET_MESSAGE' | 'FEEDBACK',
  sourceId: string,
  now: Date,
): void {
  for (const item of prepared) {
    if (item.bindingId === null || item.reservation === null) continue;
    const binding = requiredBinding(state, item.bindingId);
    if (
      binding.status !== 'RESERVED' ||
      !matchesGeneration(binding, item) ||
      !ownsReservation(binding, item.reservation)
    )
      throw new TicketError('SUPPORT_BINDING_CLAIM_CONFLICT');
    state.bindings.set(binding.id, {
      ...binding,
      sourceType,
      sourceId,
      status: 'FINALIZE_PENDING',
      nextAttemptAt: now,
      claimToken: null,
      leaseUntil: null,
      lastError: null,
    });
  }
}

function emptyState(): TicketState {
  return {
    tickets: new Map(),
    messages: new Map(),
    notes: new Map(),
    feedback: new Map(),
    bindings: new Map(),
    compensations: new Map(),
    outbox: [],
  };
}
function cloneState(state: TicketState): TicketState {
  return {
    tickets: new Map(structuredClone([...state.tickets])),
    messages: new Map(structuredClone([...state.messages])),
    notes: new Map(structuredClone([...state.notes])),
    feedback: new Map(structuredClone([...state.feedback])),
    bindings: new Map(structuredClone([...state.bindings])),
    compensations: new Map(structuredClone([...state.compensations])),
    outbox: structuredClone(state.outbox),
  };
}
function requiredTicket(state: TicketState, ticketId: string): Ticket {
  const ticket = state.tickets.get(ticketId);
  if (ticket === undefined) throw new TicketError('TICKET_NOT_FOUND');
  return ticket;
}
function requiredBinding(state: TicketState, bindingId: string): SupportUploadBinding {
  const binding = state.bindings.get(bindingId);
  if (binding === undefined) throw new TicketError('SUPPORT_BINDING_CLAIM_CONFLICT');
  return binding;
}
function bindingIds(prepared: readonly PreparedAttachment[]): string[] {
  return prepared.flatMap((item) => (item.bindingId === null ? [] : [item.bindingId]));
}
function matchesGeneration(binding: SupportUploadBinding, item: PreparedAttachment): boolean {
  return (
    item.generation !== null &&
    item.remoteOperationId !== null &&
    item.fence !== null &&
    binding.generation === item.generation &&
    binding.remoteOperationId === item.remoteOperationId &&
    binding.fence === item.fence
  );
}
function sameGeneration(left: SupportUploadBinding, right: SupportUploadBinding): boolean {
  return (
    left.generation === right.generation &&
    left.remoteOperationId === right.remoteOperationId &&
    left.fence === right.fence
  );
}
function ownsReservation(
  binding: SupportUploadBinding,
  reservation: AttachmentReservation,
): boolean {
  return (
    binding.operationId === reservation.operationId &&
    binding.remoteOperationId === reservation.remoteOperationId &&
    binding.generation === reservation.generation &&
    binding.fence === reservation.fence &&
    binding.requestHash === reservation.requestHash &&
    binding.ownershipToken !== null &&
    binding.ownershipToken === reservation.ownershipToken
  );
}
function reservationError(
  reservation: AttachmentReservation,
  expected: {
    operationId: string;
    remoteOperationId: string;
    generation: number;
    fence: string;
    requestHash: string;
    sessionId: string;
    assetId: string;
    ownerId: string;
    now: Date;
  },
): TicketError | null {
  const identityError = reservationIdentityError(reservation, expected);
  if (
    identityError !== null ||
    reservation.sessionId !== expected.sessionId ||
    reservation.assetId !== expected.assetId ||
    reservation.ownerId !== expected.ownerId ||
    reservation.purpose !== 'SUPPORT_TICKET'
  )
    return new TicketError('ATTACHMENT_NOT_AUTHORIZED');
  return reservation.expiresAt.valueOf() <= expected.now.valueOf()
    ? new TicketError('SUPPORT_UPLOAD_SESSION_EXPIRED')
    : null;
}
function reservationIdentityError(
  reservation: AttachmentReservation,
  expected: {
    operationId: string;
    remoteOperationId: string;
    generation: number;
    fence: string;
    requestHash: string;
  },
): TicketError | null {
  return reservation.operationId !== expected.operationId ||
    reservation.remoteOperationId !== expected.remoteOperationId ||
    reservation.generation !== expected.generation ||
    reservation.fence !== expected.fence ||
    reservation.requestHash !== expected.requestHash ||
    reservation.ownershipToken.length < 16
    ? new TicketError('ATTACHMENT_NOT_AUTHORIZED')
    : null;
}
function reservationFromBinding(binding: SupportUploadBinding): AttachmentReservation | null {
  return binding.reservationId === null || binding.ownershipToken === null
    ? null
    : {
        id: binding.reservationId,
        operationId: binding.operationId,
        remoteOperationId: binding.remoteOperationId,
        generation: binding.generation,
        fence: binding.fence,
        requestHash: binding.requestHash,
        ownershipToken: binding.ownershipToken,
        sessionId: binding.sessionId,
        assetId: binding.assetId,
        ownerId: binding.ownerId,
        purpose: 'SUPPORT_TICKET',
        expiresAt: new Date(8_640_000_000_000_000),
      };
}
function compensationReservation(row: SupportUploadCompensation): AttachmentReservation {
  return {
    id: row.reservationId,
    operationId: row.operationId,
    remoteOperationId: row.remoteOperationId,
    generation: row.generation,
    fence: row.fence,
    requestHash: row.requestHash,
    ownershipToken: row.ownershipToken,
    sessionId: row.sessionId,
    ownerId: row.ownerId,
    assetId: row.assetId,
    purpose: row.purpose,
    expiresAt: row.expiresAt,
  };
}
function guardRevision(ticket: Ticket, expectedRevision: number): void {
  if (
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0 ||
    ticket.revision !== expectedRevision
  )
    throw new TicketError('TICKET_REVISION_CONFLICT');
}
function assertUuid(value: string, code: string): void {
  if (!isUuidV7(value)) throw new TicketError(code);
}
function assertIdempotencyKey(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value))
    throw new TicketError('INVALID_IDEMPOTENCY_KEY');
}
function cleanText(value: string, max: number, code: string): string {
  if (typeof value !== 'string') throw new TicketError(code);
  const result = value.trim();
  if (result.length === 0 || result.length > max) throw new TicketError(code);
  return result;
}
function validateLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 100)
    throw new TicketError('INVALID_PAGE_SIZE');
  return value;
}
function validateAttachments(value: readonly AttachmentInput[] | undefined): AttachmentInput[] {
  const rows = value === undefined ? [] : [...value];
  if (rows.length > 10) throw new TicketError('TOO_MANY_ATTACHMENTS');
  const seen = new Set<string>();
  for (const row of rows) {
    assertUuid(row.assetId, 'INVALID_ATTACHMENT');
    if (row.supportUploadSessionId !== undefined)
      assertUuid(row.supportUploadSessionId, 'INVALID_ATTACHMENT');
    if (seen.has(row.assetId)) throw new TicketError('INVALID_ATTACHMENT');
    seen.add(row.assetId);
  }
  return rows;
}
function validateFeedback(input: { kind: FeedbackKind; taskId?: string; rating?: number }): void {
  if (!['MODEL_RESULT', 'FAILED_TASK', 'PRODUCT_SUGGESTION'].includes(input.kind))
    throw new TicketError('INVALID_FEEDBACK');
  if (
    input.rating !== undefined &&
    (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5)
  )
    throw new TicketError('INVALID_FEEDBACK');
  if (
    (input.kind === 'MODEL_RESULT' || input.kind === 'FAILED_TASK') &&
    (input.taskId === undefined || !isUuidV7(input.taskId))
  )
    throw new TicketError('INVALID_FEEDBACK');
  if (input.taskId !== undefined && !isUuidV7(input.taskId))
    throw new TicketError('INVALID_FEEDBACK');
}
function hashRequest(body: string, attachments: readonly AttachmentInput[]): string {
  return createHash('sha256').update(JSON.stringify({ body, attachments })).digest('hex');
}
function hashValue(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function publicMessages(state: TicketState, ticketId: string): TicketMessage[] {
  return [...state.messages.values()]
    .filter((message) => message.ticketId === ticketId)
    .sort(byCreated);
}
function byCreated<T extends { createdAt: Date; id: string }>(left: T, right: T): number {
  return left.createdAt.valueOf() - right.createdAt.valueOf() || left.id.localeCompare(right.id);
}
function newestFirst(left: Ticket, right: Ticket): number {
  return right.createdAt.valueOf() - left.createdAt.valueOf() || right.id.localeCompare(left.id);
}
function compareCursor(ticket: Ticket, cursor: { createdAt: Date; id: string }): number {
  return (
    ticket.createdAt.valueOf() - cursor.createdAt.valueOf() || ticket.id.localeCompare(cursor.id)
  );
}
function newestCreatedFirst(
  left: { createdAt: Date; id: string },
  right: { createdAt: Date; id: string },
): number {
  return right.createdAt.valueOf() - left.createdAt.valueOf() || right.id.localeCompare(left.id);
}
function compareCreatedCursor(
  row: { createdAt: Date; id: string },
  cursor: { createdAt: Date; id: string },
): number {
  return row.createdAt.valueOf() - cursor.createdAt.valueOf() || row.id.localeCompare(cursor.id);
}
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), 'utf8').toString(
    'base64url',
  );
}
function decodeCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    const createdAt = new Date(String(parsed.createdAt));
    const id = String(parsed.id);
    if (Number.isNaN(createdAt.valueOf()) || !isUuidV7(id)) throw new Error();
    return { createdAt, id };
  } catch {
    throw new TicketError('INVALID_CURSOR');
  }
}

function addEvent(
  state: TicketState,
  id: string,
  type: string,
  data: unknown,
  now: Date,
  context: OperationRequestContext,
): void {
  const envelope = {
    id,
    type,
    version: 1,
    occurredAt: now.toISOString(),
    traceId: context.traceId,
    correlationId: context.correlationId,
    ...(context.causationId === undefined ? {} : { causationId: context.causationId }),
    producer: 'operations-service',
    data,
  };
  validateTicketEventEnvelope(envelope);
  state.outbox.push({ ...envelope, status: 'PENDING', attempts: 0, createdAt: now });
}

export function validateTicketEventEnvelope(value: unknown): void {
  const parsed = EventEnvelopeSchema.safeParse(value);
  if (
    !parsed.success ||
    !isUuidV7(parsed.data.id) ||
    !isUuidV7(parsed.data.correlationId) ||
    (parsed.data.causationId !== undefined && !isUuidV7(parsed.data.causationId))
  )
    throw new TicketError('INVALID_REQUEST_CONTEXT');
}
