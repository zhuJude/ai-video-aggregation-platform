import 'server-only';

import { UuidSchema } from '@repo/contracts/common';

import { findMockObject } from '../commerce/mock-object-store';
import { createUuidV7, isUuidV7 } from '../tasks/identifiers';
import { readSupportState, replaySupportCommand, runSupportCommand } from './mock-store';
import type { MessageView, SupportGateway, TicketAttachmentView, TicketView } from './types';

const PAGE_SIZE = 3;
const REOPEN_WINDOW_MS = 7 * 24 * 60 * 60_000;
const TICKET_CATEGORIES = new Set<TicketView['category']>([
  'TASK',
  'PAYMENT',
  'ACCOUNT',
  'SUGGESTION',
  'OTHER',
]);

export class SupportGatewayError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;
}

function owner(ownerId: string): string {
  const parsed = UuidSchema.safeParse(ownerId);
  if (!parsed.success) throw new SupportGatewayError('INVALID_OWNER');
  return parsed.data;
}

function offset(cursor?: string): number {
  if (!cursor) return 0;
  const match = /^page-(\d+)$/.exec(cursor);
  if (!match) throw new SupportGatewayError('INVALID_CURSOR');
  const page = Number(match[1]);
  if (!Number.isSafeInteger(page) || page < 1) throw new SupportGatewayError('INVALID_CURSOR');
  return (page - 1) * PAGE_SIZE;
}

function pageInfo(start: number, total: number) {
  const current = Math.floor(start / PAGE_SIZE) + 1;
  return {
    ...(start > 0 ? { previousCursor: `page-${String(current - 1)}` } : {}),
    ...(start + PAGE_SIZE < total ? { nextCursor: `page-${String(current + 1)}` } : {}),
  };
}

async function attachments(
  ids: readonly string[],
  ownerId: string,
): Promise<TicketAttachmentView[]> {
  if (ids.length > 5 || new Set(ids).size !== ids.length || ids.some((id) => !isUuidV7(id)))
    throw new SupportGatewayError('INVALID_ATTACHMENTS');
  return Promise.all(
    ids.map(async (id) => {
      const asset = await findMockObject(id, ownerId);
      if (
        !asset ||
        !['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(asset.mimeType)
      ) {
        throw new SupportGatewayError('ATTACHMENT_NOT_FOUND');
      }
      if (BigInt(asset.sizeBytes) > 20n * 1024n * 1024n)
        throw new SupportGatewayError('ATTACHMENT_TOO_LARGE');
      return {
        id: asset.assetId,
        name: asset.name,
        mimeType: asset.mimeType,
        sizeBytes: asset.sizeBytes,
      };
    }),
  );
}

function requireBody(value: string, min: number, max: number, code: string): string {
  const body = value.trim();
  if (
    body.length < min ||
    body.length > max ||
    Array.from(body).some((character) => {
      const characterCode = character.charCodeAt(0);
      return (
        (characterCode < 32 &&
          characterCode !== 9 &&
          characterCode !== 10 &&
          characterCode !== 13) ||
        characterCode === 127
      );
    })
  ) {
    throw new SupportGatewayError(code);
  }
  return body;
}

function mayReopen(ticket: TicketView, now = Date.now()): boolean {
  const updatedAt = Date.parse(ticket.updatedAt);
  return (
    ticket.status === 'RESOLVED' &&
    Number.isFinite(updatedAt) &&
    updatedAt <= now &&
    now - updatedAt <= REOPEN_WINDOW_MS
  );
}

export const supportGateway: SupportGateway = {
  async listMessages(filters, context) {
    const state = await readSupportState(owner(context.ownerId));
    const matches = state.messages.filter(
      (message) =>
        (!filters.kind || message.kind === filters.kind) &&
        (filters.state !== 'UNREAD' || message.readAt === undefined),
    );
    const start = offset(filters.cursor);
    return {
      items: matches.slice(start, start + PAGE_SIZE),
      unreadCount: state.messages.filter((message) => message.readAt === undefined).length,
      pageInfo: pageInfo(start, matches.length),
    };
  },

  async markMessagesRead(ids, context) {
    const ownerId = owner(context.ownerId);
    if (
      ids.length === 0 ||
      ids.length > 100 ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !isUuidV7(id))
    ) {
      throw new SupportGatewayError('INVALID_MESSAGE_SELECTION');
    }
    const fingerprint = `message-read:${JSON.stringify([...ids].sort())}`;
    return runSupportCommand(
      ownerId,
      { key: context.idempotencyKey, kind: 'MESSAGE_READ', fingerprint },
      (state) => {
        if (ids.some((id) => !state.messages.some((message) => message.id === id))) {
          throw new SupportGatewayError('MESSAGE_NOT_FOUND');
        }
        const readAt = new Date().toISOString();
        state.messages = state.messages.map((message): MessageView =>
          ids.includes(message.id) && !message.readAt ? { ...message, readAt } : message,
        );
        return { readAt };
      },
    );
  },

  async listTickets(filters, context) {
    const state = await readSupportState(owner(context.ownerId));
    const matches = state.tickets.filter(
      (ticket) => !filters.status || ticket.status === filters.status,
    );
    const start = offset(filters.cursor);
    // internalNotes deliberately never cross this boundary.
    return {
      items: matches.slice(start, start + PAGE_SIZE),
      pageInfo: pageInfo(start, matches.length),
    };
  },

  async createTicket(input, context) {
    const ownerId = owner(context.ownerId);
    if (!TICKET_CATEGORIES.has(input.category))
      throw new SupportGatewayError('INVALID_TICKET_CATEGORY');
    const subject = requireBody(input.subject, 4, 120, 'INVALID_TICKET_SUBJECT');
    const body = requireBody(input.body, 10, 4_000, 'INVALID_TICKET_BODY');
    const fingerprint = `ticket-create:${JSON.stringify({ subject, category: input.category, body, attachmentIds: input.attachmentIds })}`;
    const command = { key: context.idempotencyKey, kind: 'TICKET_CREATE' as const, fingerprint };
    const replay = await replaySupportCommand(ownerId, command);
    if (replay.found) return replay.result;
    const safeAttachments = await attachments(input.attachmentIds, ownerId);
    return runSupportCommand(ownerId, command, (state) => {
      const now = new Date().toISOString();
      const ticket: TicketView = {
        id: createUuidV7(),
        subject,
        category: input.category,
        status: 'OPEN',
        createdAt: now,
        updatedAt: now,
        replies: [
          {
            id: createUuidV7(),
            author: 'USER',
            body,
            createdAt: now,
            attachments: safeAttachments,
          },
        ],
        statusHistory: [{ status: 'OPEN', occurredAt: now, label: '工单已创建' }],
        canClose: false,
        canReopen: false,
      };
      state.tickets.unshift(ticket);
      return ticket;
    });
  },

  async replyTicket(ticketId, input, context) {
    const ownerId = owner(context.ownerId);
    if (!isUuidV7(ticketId)) throw new SupportGatewayError('TICKET_NOT_FOUND');
    const body = requireBody(input.body, 1, 4_000, 'INVALID_TICKET_BODY');
    const fingerprint = `ticket-reply:${JSON.stringify({ ticketId, body, attachmentIds: input.attachmentIds })}`;
    const command = { key: context.idempotencyKey, kind: 'TICKET_REPLY' as const, fingerprint };
    const replay = await replaySupportCommand(ownerId, command);
    if (replay.found) return replay.result;
    const safeAttachments = await attachments(input.attachmentIds, ownerId);
    return runSupportCommand(ownerId, command, (state) => {
      const index = state.tickets.findIndex((ticket) => ticket.id === ticketId);
      const current = state.tickets[index];
      if (
        !current ||
        current.status === 'CLOSED' ||
        (current.status === 'RESOLVED' && !mayReopen(current))
      )
        throw new SupportGatewayError('TICKET_NOT_REPLYABLE');
      const now = new Date().toISOString();
      const reopens = current.status === 'RESOLVED';
      const next: TicketView = {
        ...current,
        ...(reopens
          ? {
              status: 'IN_PROGRESS' as const,
              canClose: false,
              canReopen: false,
              statusHistory: [
                ...current.statusHistory,
                { status: 'IN_PROGRESS' as const, occurredAt: now, label: '用户回复并重开工单' },
              ],
            }
          : {}),
        updatedAt: now,
        replies: [
          ...current.replies,
          {
            id: createUuidV7(),
            author: 'USER',
            body,
            createdAt: now,
            attachments: safeAttachments,
          },
        ],
      };
      state.tickets[index] = next;
      return next;
    });
  },

  async changeTicketStatus(ticketId, action, context) {
    const ownerId = owner(context.ownerId);
    if (!isUuidV7(ticketId)) throw new SupportGatewayError('TICKET_NOT_FOUND');
    const fingerprint = `ticket-status:${ticketId}:${action}`;
    return runSupportCommand(
      ownerId,
      { key: context.idempotencyKey, kind: 'TICKET_STATUS', fingerprint },
      (state) => {
        const index = state.tickets.findIndex((ticket) => ticket.id === ticketId);
        const current = state.tickets[index];
        if (!current) throw new SupportGatewayError('TICKET_NOT_FOUND');
        if (
          (action === 'REOPEN' && !mayReopen(current)) ||
          (action === 'CLOSE' && current.status !== 'RESOLVED')
        ) {
          throw new SupportGatewayError('TICKET_ACTION_NOT_ALLOWED');
        }
        const now = new Date().toISOString();
        const status = action === 'REOPEN' ? ('IN_PROGRESS' as const) : ('CLOSED' as const);
        const next: TicketView = {
          ...current,
          status,
          updatedAt: now,
          canClose: false,
          canReopen: false,
          statusHistory: [
            ...current.statusHistory,
            {
              status,
              occurredAt: now,
              label: action === 'REOPEN' ? '用户已重开工单' : '用户已关闭工单',
            },
          ],
        };
        state.tickets[index] = next;
        return next;
      },
    );
  },

  async submitTicketSatisfaction(ticketId, input, context) {
    const ownerId = owner(context.ownerId);
    if (!isUuidV7(ticketId)) throw new SupportGatewayError('TICKET_NOT_FOUND');
    if (!Number.isSafeInteger(input.rating) || input.rating < 1 || input.rating > 5)
      throw new SupportGatewayError('INVALID_SATISFACTION');
    const comment =
      input.comment === undefined
        ? undefined
        : requireBody(input.comment, 1, 500, 'INVALID_SATISFACTION');
    const fingerprint = `ticket-satisfaction:${JSON.stringify({ ticketId, rating: input.rating, comment })}`;
    return runSupportCommand(
      ownerId,
      { key: context.idempotencyKey, kind: 'TICKET_SATISFACTION', fingerprint },
      (state) => {
        const index = state.tickets.findIndex(({ id }) => id === ticketId);
        const current = state.tickets[index];
        if (!current) throw new SupportGatewayError('TICKET_NOT_FOUND');
        if (!['RESOLVED', 'CLOSED'].includes(current.status) || current.satisfaction)
          throw new SupportGatewayError('SATISFACTION_NOT_ALLOWED');
        const satisfaction = {
          rating: input.rating as 1 | 2 | 3 | 4 | 5,
          ...(comment ? { comment } : {}),
          createdAt: new Date().toISOString(),
        };
        state.tickets[index] = { ...current, satisfaction };
        return satisfaction;
      },
    );
  },

  async submitFeedback(input, context) {
    const ownerId = owner(context.ownerId);
    if (!['MODEL_RESULT', 'FAILED_TASK', 'PRODUCT_SUGGESTION'].includes(input.kind))
      throw new SupportGatewayError('INVALID_FEEDBACK');
    const body = requireBody(input.body, 10, 2_000, 'INVALID_FEEDBACK');
    if (
      (input.kind === 'PRODUCT_SUGGESTION' && input.referenceId !== undefined) ||
      (input.kind !== 'PRODUCT_SUGGESTION' && !isUuidV7(input.referenceId))
    )
      throw new SupportGatewayError('INVALID_FEEDBACK_REFERENCE');
    const normalized = {
      kind: input.kind,
      body,
      ...(input.referenceId ? { referenceId: input.referenceId } : {}),
    };
    const fingerprint = `feedback:${JSON.stringify(normalized)}`;
    return runSupportCommand(
      ownerId,
      { key: context.idempotencyKey, kind: 'FEEDBACK_CREATE', fingerprint },
      (state) => {
        const feedback = { id: createUuidV7(), ...normalized, createdAt: new Date().toISOString() };
        state.feedback.unshift(feedback);
        return feedback;
      },
    );
  },
};
