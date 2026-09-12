import { UtcDateTimeSchema, UuidSchema } from '@repo/contracts/common';
import { TicketStatusSchema } from '@repo/contracts/operations';

import type {
  CursorPageInfo,
  MessageFilters,
  MessageKind,
  MessagePage,
  MessageView,
  TicketAttachmentView,
  FeedbackKind,
  FeedbackView,
  TicketFilters,
  TicketPage,
  TicketReplyView,
  TicketStatus,
  TicketView,
} from './types';

const MESSAGE_KINDS = new Set<MessageKind>(['TASK', 'PAYMENT', 'BALANCE', 'SYSTEM']);
const TICKET_CATEGORIES = new Set<TicketView['category']>([
  'TASK',
  'PAYMENT',
  'ACCOUNT',
  'SUGGESTION',
  'OTHER',
]);
const APP_PATH =
  /^\/(?:tasks(?:\/[A-Za-z0-9_-]+)?|assets|wallet|orders|invoices|messages|tickets(?:\/[A-Za-z0-9_-]+)?|studio|settings\/(?:profile|security)|models(?:\/[A-Za-z0-9_-]+)?|pricing|help(?:\/[A-Za-z0-9_-]+)*)$/;
const QUERY_KEYS: Readonly<Record<string, ReadonlySet<string>>> = {
  '/wallet': new Set(['type', 'cursor']),
  '/orders': new Set(['status', 'cursor']),
  '/messages': new Set(['state', 'kind', 'cursor']),
  '/tickets': new Set(['status', 'cursor', 'ticket']),
  '/tasks': new Set(['status', 'time', 'model', 'generationMode', 'taskNumber', 'cursor']),
};

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(code);
}

function text(value: unknown, code: string, max: number): string {
  if (typeof value !== 'string') throw new Error(code);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > max ||
    Array.from(normalized).some((character) => {
      const characterCode = character.charCodeAt(0);
      return characterCode < 32 || characterCode === 127;
    })
  ) {
    throw new Error(code);
  }
  return normalized;
}

function uuid(value: unknown, code: string): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

function instant(value: unknown, code: string): string {
  const parsed = UtcDateTimeSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

function pageInfo(value: unknown, code: string): CursorPageInfo {
  const page = record(value, code);
  exact(page, ['previousCursor', 'nextCursor'], code);
  const cursor = (candidate: unknown): string | undefined =>
    candidate === undefined ? undefined : text(candidate, code, 256);
  const previousCursor = cursor(page.previousCursor);
  const nextCursor = cursor(page.nextCursor);
  return {
    ...(previousCursor ? { previousCursor } : {}),
    ...(nextCursor ? { nextCursor } : {}),
  };
}

export function safeMessageDeepLink(value: unknown): string | undefined {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    Array.from(value).some((character) => {
      const characterCode = character.charCodeAt(0);
      return characterCode < 32 || characterCode === 127;
    }) ||
    /%(?:2e|2f|5c)/i.test(value) ||
    value
      .split(/[?#]/, 1)[0]
      ?.split('/')
      .some((segment) => segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(value, 'https://user-web.invalid');
  } catch {
    return undefined;
  }
  if (url.origin !== 'https://user-web.invalid' || url.hash || !APP_PATH.test(url.pathname)) {
    return undefined;
  }
  const routeKey = Object.keys(QUERY_KEYS)
    .sort((a, b) => b.length - a.length)
    .find((candidate) => url.pathname === candidate || url.pathname.startsWith(`${candidate}/`));
  if (url.search) {
    const allowed = routeKey ? QUERY_KEYS[routeKey] : undefined;
    if (!allowed) return undefined;
    for (const [key, queryValue] of url.searchParams) {
      if (
        !allowed.has(key) ||
        queryValue.length > 160 ||
        Array.from(queryValue).some((character) => {
          const characterCode = character.charCodeAt(0);
          return characterCode < 32 || characterCode === 127;
        })
      ) {
        return undefined;
      }
    }
  }
  return `${url.pathname}${url.search}`;
}

function parseMessage(value: unknown): MessageView {
  const message = record(value, 'INVALID_MESSAGE');
  exact(
    message,
    ['id', 'kind', 'title', 'summary', 'occurredAt', 'readAt', 'deepLink'],
    'INVALID_MESSAGE',
  );
  if (!MESSAGE_KINDS.has(message.kind as MessageKind)) throw new Error('INVALID_MESSAGE');
  const deepLink =
    message.deepLink === undefined ? undefined : safeMessageDeepLink(message.deepLink);
  if (message.deepLink !== undefined && deepLink === undefined) throw new Error('INVALID_MESSAGE');
  const readAt =
    message.readAt === undefined ? undefined : instant(message.readAt, 'INVALID_MESSAGE');
  return {
    id: uuid(message.id, 'INVALID_MESSAGE'),
    kind: message.kind as MessageKind,
    title: text(message.title, 'INVALID_MESSAGE', 100),
    summary: text(message.summary, 'INVALID_MESSAGE', 500),
    occurredAt: instant(message.occurredAt, 'INVALID_MESSAGE'),
    ...(readAt ? { readAt } : {}),
    ...(deepLink ? { deepLink } : {}),
  };
}

export function parseMessagePage(value: unknown): MessagePage {
  const page = record(value, 'INVALID_MESSAGE_PAGE');
  exact(page, ['items', 'unreadCount', 'pageInfo'], 'INVALID_MESSAGE_PAGE');
  if (
    !Array.isArray(page.items) ||
    !Number.isSafeInteger(page.unreadCount) ||
    (page.unreadCount as number) < 0
  ) {
    throw new Error('INVALID_MESSAGE_PAGE');
  }
  return {
    items: page.items.map(parseMessage),
    unreadCount: page.unreadCount as number,
    pageInfo: pageInfo(page.pageInfo, 'INVALID_MESSAGE_PAGE'),
  };
}

function parseAttachment(value: unknown): TicketAttachmentView {
  const attachment = record(value, 'INVALID_TICKET');
  exact(attachment, ['id', 'name', 'mimeType', 'sizeBytes'], 'INVALID_TICKET');
  if (typeof attachment.sizeBytes !== 'string' || !/^(0|[1-9]\d*)$/.test(attachment.sizeBytes)) {
    throw new Error('INVALID_TICKET');
  }
  const mimeType = text(attachment.mimeType, 'INVALID_TICKET', 100).toLowerCase();
  if (!['image/jpeg', 'image/png', 'image/webp', 'video/mp4'].includes(mimeType)) {
    throw new Error('INVALID_TICKET');
  }
  return {
    id: uuid(attachment.id, 'INVALID_TICKET'),
    name: text(attachment.name, 'INVALID_TICKET', 120),
    mimeType,
    sizeBytes: attachment.sizeBytes,
  };
}

function parseReply(value: unknown): TicketReplyView {
  const reply = record(value, 'INVALID_TICKET');
  exact(reply, ['id', 'author', 'body', 'createdAt', 'attachments'], 'INVALID_TICKET');
  if (reply.author !== 'USER' && reply.author !== 'SUPPORT') throw new Error('INVALID_TICKET');
  if (!Array.isArray(reply.attachments) || reply.attachments.length > 5)
    throw new Error('INVALID_TICKET');
  return {
    id: uuid(reply.id, 'INVALID_TICKET'),
    author: reply.author,
    body: text(reply.body, 'INVALID_TICKET', 4_000),
    createdAt: instant(reply.createdAt, 'INVALID_TICKET'),
    attachments: reply.attachments.map(parseAttachment),
  };
}

function parseStatus(value: unknown): TicketStatus {
  const status = TicketStatusSchema.safeParse(value);
  if (!status.success) throw new Error('INVALID_TICKET');
  return status.data;
}

function parseTicket(value: unknown): TicketView {
  const ticket = record(value, 'INVALID_TICKET');
  exact(
    ticket,
    [
      'id',
      'subject',
      'category',
      'status',
      'createdAt',
      'updatedAt',
      'replies',
      'statusHistory',
      'canClose',
      'canReopen',
      'satisfaction',
    ],
    'INVALID_TICKET',
  );
  if (!TICKET_CATEGORIES.has(ticket.category as TicketView['category']))
    throw new Error('INVALID_TICKET');
  if (!Array.isArray(ticket.replies) || !Array.isArray(ticket.statusHistory))
    throw new Error('INVALID_TICKET');
  if (typeof ticket.canClose !== 'boolean' || typeof ticket.canReopen !== 'boolean')
    throw new Error('INVALID_TICKET');
  const satisfaction =
    ticket.satisfaction === undefined ? undefined : record(ticket.satisfaction, 'INVALID_TICKET');
  if (satisfaction) {
    exact(satisfaction, ['rating', 'comment', 'createdAt'], 'INVALID_TICKET');
    if (
      !Number.isSafeInteger(satisfaction.rating) ||
      (satisfaction.rating as number) < 1 ||
      (satisfaction.rating as number) > 5
    )
      throw new Error('INVALID_TICKET');
  }
  const subject = text(ticket.subject, 'INVALID_TICKET', 120);
  if (subject.length < 4) throw new Error('INVALID_TICKET');
  return {
    id: uuid(ticket.id, 'INVALID_TICKET'),
    subject,
    category: ticket.category as TicketView['category'],
    status: parseStatus(ticket.status),
    createdAt: instant(ticket.createdAt, 'INVALID_TICKET'),
    updatedAt: instant(ticket.updatedAt, 'INVALID_TICKET'),
    replies: ticket.replies.map(parseReply),
    statusHistory: ticket.statusHistory.map((rawHistory) => {
      const history = record(rawHistory, 'INVALID_TICKET');
      exact(history, ['status', 'occurredAt', 'label'], 'INVALID_TICKET');
      return {
        status: parseStatus(history.status),
        occurredAt: instant(history.occurredAt, 'INVALID_TICKET'),
        label: text(history.label, 'INVALID_TICKET', 120),
      };
    }),
    canClose: ticket.canClose,
    canReopen: ticket.canReopen,
    ...(satisfaction
      ? {
          satisfaction: {
            rating: satisfaction.rating as 1 | 2 | 3 | 4 | 5,
            ...(satisfaction.comment === undefined
              ? {}
              : { comment: text(satisfaction.comment, 'INVALID_TICKET', 500) }),
            createdAt: instant(satisfaction.createdAt, 'INVALID_TICKET'),
          },
        }
      : {}),
  };
}

const FEEDBACK_KINDS = new Set<FeedbackKind>(['MODEL_RESULT', 'FAILED_TASK', 'PRODUCT_SUGGESTION']);

export function parseFeedback(value: unknown): FeedbackView {
  const feedback = record(value, 'INVALID_FEEDBACK');
  exact(feedback, ['id', 'kind', 'body', 'referenceId', 'createdAt'], 'INVALID_FEEDBACK');
  if (!FEEDBACK_KINDS.has(feedback.kind as FeedbackKind)) throw new Error('INVALID_FEEDBACK');
  if (
    feedback.referenceId !== undefined &&
    (typeof feedback.referenceId !== 'string' ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(feedback.referenceId))
  )
    throw new Error('INVALID_FEEDBACK');
  return {
    id: uuid(feedback.id, 'INVALID_FEEDBACK'),
    kind: feedback.kind as FeedbackKind,
    body: text(feedback.body, 'INVALID_FEEDBACK', 2_000),
    ...(feedback.referenceId ? { referenceId: feedback.referenceId } : {}),
    createdAt: instant(feedback.createdAt, 'INVALID_FEEDBACK'),
  };
}

export function parseTicketPage(value: unknown): TicketPage {
  const page = record(value, 'INVALID_TICKET_PAGE');
  exact(page, ['items', 'pageInfo'], 'INVALID_TICKET_PAGE');
  if (!Array.isArray(page.items)) throw new Error('INVALID_TICKET_PAGE');
  return {
    items: page.items.map(parseTicket),
    pageInfo: pageInfo(page.pageInfo, 'INVALID_TICKET_PAGE'),
  };
}

export function parseMessageFilters(
  value: Record<string, string | string[] | undefined>,
): MessageFilters {
  const scalar = (name: string) =>
    typeof value[name] === 'string' ? value[name].trim() : undefined;
  const state = scalar('state');
  const kind = scalar('kind');
  if (state && state !== 'ALL' && state !== 'UNREAD') throw new Error('INVALID_MESSAGE_FILTER');
  if (kind && !MESSAGE_KINDS.has(kind as MessageKind)) throw new Error('INVALID_MESSAGE_FILTER');
  const cursor = scalar('cursor');
  return {
    ...(state ? { state: state as 'ALL' | 'UNREAD' } : {}),
    ...(kind ? { kind: kind as MessageKind } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function parseTicketFilters(
  value: Record<string, string | string[] | undefined>,
): TicketFilters {
  const statusValue = typeof value.status === 'string' ? value.status.trim() : undefined;
  const status = statusValue ? TicketStatusSchema.safeParse(statusValue) : undefined;
  if (status && !status.success) throw new Error('INVALID_TICKET_FILTER');
  const cursor =
    typeof value.cursor === 'string' && value.cursor.trim() ? value.cursor.trim() : undefined;
  return { ...(status?.success ? { status: status.data } : {}), ...(cursor ? { cursor } : {}) };
}

const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Shanghai',
});

export function formatSupportDate(value: string): string {
  return DATE_FORMATTER.format(new Date(instant(value, 'INVALID_SUPPORT_DATE')));
}
