import 'server-only';

import { createHash } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';

import { transactMockStoreJson } from '../commerce/mock-object-store';
import { createUuidV7, isUuidV7 } from '../tasks/identifiers';
import { parseFeedback, parseMessagePage, parseTicketPage } from './runtime';
import type { FeedbackView, MessageView, TicketView } from './types';

const COMMAND_TTL_MS = 24 * 60 * 60_000;
const MAX_COMMANDS = 5_000;

export type CommandKind =
  | 'MESSAGE_READ'
  | 'TICKET_CREATE'
  | 'TICKET_REPLY'
  | 'TICKET_STATUS'
  | 'TICKET_SATISFACTION'
  | 'FEEDBACK_CREATE';

interface StoredCommand {
  readonly key: string;
  readonly fingerprint: string;
  readonly kind: CommandKind;
  readonly result: unknown;
  readonly expiresAt: string;
}

export interface SupportState {
  readonly version: 2;
  readonly ownerId: string;
  readonly messages: readonly MessageView[];
  readonly tickets: readonly TicketView[];
  readonly feedback: readonly FeedbackView[];
  readonly internalNotes: Readonly<Record<string, readonly string[]>>;
  readonly commands: readonly StoredCommand[];
}

export interface MutableSupportState {
  messages: MessageView[];
  tickets: TicketView[];
  feedback: FeedbackView[];
}

export class SupportStoreError extends Error {
  readonly outcome: 'DEFINITIVE_FAILURE' | 'UNCERTAIN';

  constructor(readonly code: 'CAPACITY' | 'IDEMPOTENCY_CONFLICT' | 'INVALID') {
    super(`SUPPORT_STORE_${code}`);
    this.outcome = 'DEFINITIVE_FAILURE';
  }
}

function requireMockSupport(): void {
  if (process.env.USER_WEB_SUPPORT_MODE !== 'mock') throw new Error('SUPPORT_SERVICE_UNAVAILABLE');
}

function fileName(ownerId: string): string {
  requireMockSupport();
  if (!UuidSchema.safeParse(ownerId).success) throw new SupportStoreError('INVALID');
  return `.support-${createHash('sha256').update(`support:v2:${ownerId}`).digest('hex')}.json`;
}

function parseState(value: unknown, ownerId: string): SupportState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SupportStoreError('INVALID');
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).sort().join(',') !==
      'commands,feedback,internalNotes,messages,ownerId,tickets,version' ||
    state.version !== 2 ||
    state.ownerId !== ownerId ||
    !Array.isArray(state.commands) ||
    !state.internalNotes ||
    typeof state.internalNotes !== 'object' ||
    Array.isArray(state.internalNotes)
  ) {
    throw new SupportStoreError('INVALID');
  }
  const messages = parseMessagePage({ items: state.messages, unreadCount: 0, pageInfo: {} }).items;
  const tickets = parseTicketPage({ items: state.tickets, pageInfo: {} }).items;
  if (!Array.isArray(state.feedback)) throw new SupportStoreError('INVALID');
  const feedback = state.feedback.map(parseFeedback);
  const internalNotes = Object.fromEntries(
    Object.entries(state.internalNotes as Record<string, unknown>).map(([ticketId, notes]) => {
      if (
        !isUuidV7(ticketId) ||
        !Array.isArray(notes) ||
        notes.some((note) => typeof note !== 'string')
      ) {
        throw new SupportStoreError('INVALID');
      }
      return [ticketId, notes as string[]];
    }),
  );
  const commands = state.commands.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new SupportStoreError('INVALID');
    const command = raw as Record<string, unknown>;
    if (
      Object.keys(command).sort().join(',') !== 'expiresAt,fingerprint,key,kind,result' ||
      !isUuidV7(command.key) ||
      typeof command.fingerprint !== 'string' ||
      command.fingerprint.length > 8_192 ||
      ![
        'MESSAGE_READ',
        'TICKET_CREATE',
        'TICKET_REPLY',
        'TICKET_STATUS',
        'TICKET_SATISFACTION',
        'FEEDBACK_CREATE',
      ].includes(command.kind as string) ||
      typeof command.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(command.expiresAt))
    ) {
      throw new SupportStoreError('INVALID');
    }
    return {
      key: command.key,
      fingerprint: command.fingerprint,
      kind: command.kind as CommandKind,
      result: command.result,
      expiresAt: command.expiresAt,
    };
  });
  if (new Set(commands.map(({ key }) => key)).size !== commands.length)
    throw new SupportStoreError('INVALID');
  return { version: 2, ownerId, messages, tickets, feedback, internalNotes, commands };
}

export function supportSeed(ownerId: string): SupportState {
  const now = '2026-08-31T10:30:00.000Z';
  const messageIds = [createUuidV7(), createUuidV7(), createUuidV7()];
  const ticketId = createUuidV7();
  const userReplyId = createUuidV7();
  const supportReplyId = createUuidV7();
  return parseState(
    {
      version: 2,
      ownerId,
      messages: [
        {
          id: messageIds[0],
          kind: 'TASK',
          title: '视频已生成',
          summary: '你的海岸公路作品已生成，可前往任务详情查看。',
          occurredAt: now,
          deepLink: '/tasks/task-2',
        },
        {
          id: messageIds[1],
          kind: 'PAYMENT',
          title: '充值已到账',
          summary: '32,000 点已进入可用余额。',
          occurredAt: '2026-08-30T09:12:00.000Z',
          readAt: '2026-08-30T09:15:00.000Z',
          deepLink: '/wallet',
        },
        {
          id: messageIds[2],
          kind: 'SYSTEM',
          title: '安全提醒',
          summary: '请勿向任何人提供短信验证码。',
          occurredAt: '2026-08-29T08:00:00.000Z',
          deepLink: '/settings/security',
        },
      ],
      tickets: [
        {
          id: ticketId,
          subject: '任务结果无法播放',
          category: 'TASK',
          status: 'IN_PROGRESS',
          createdAt: '2026-08-30T02:00:00.000Z',
          updatedAt: '2026-08-31T02:00:00.000Z',
          replies: [
            {
              id: userReplyId,
              author: 'USER',
              body: '任务显示成功，但结果页面无法播放。',
              createdAt: '2026-08-30T02:00:00.000Z',
              attachments: [],
            },
            {
              id: supportReplyId,
              author: 'SUPPORT',
              body: '我们正在核对转存状态，有结果后会在这里回复。',
              createdAt: '2026-08-31T02:00:00.000Z',
              attachments: [],
            },
          ],
          statusHistory: [
            { status: 'OPEN', occurredAt: '2026-08-30T02:00:00.000Z', label: '工单已创建' },
            { status: 'IN_PROGRESS', occurredAt: '2026-08-31T02:00:00.000Z', label: '客服处理中' },
          ],
          canClose: false,
          canReopen: false,
        },
      ],
      feedback: [],
      internalNotes: {
        [ticketId]: ['转存节点排查中，仅客服可见。'],
      },
      commands: [],
    },
    ownerId,
  );
}

export async function readSupportState(ownerId: string): Promise<SupportState> {
  const now = Date.now();
  return transactMockStoreJson(fileName(ownerId), (raw) => {
    const state = parseState(raw ?? supportSeed(ownerId), ownerId);
    const commands = state.commands.filter((command) => Date.parse(command.expiresAt) > now);
    const next =
      raw === undefined || commands.length !== state.commands.length
        ? { ...state, commands }
        : undefined;
    return { result: next ? parseState(next, ownerId) : state, ...(next ? { next } : {}) };
  });
}

export async function runSupportCommand<T>(
  ownerId: string,
  request: { readonly key: string; readonly kind: CommandKind; readonly fingerprint: string },
  mutate: (state: MutableSupportState) => T,
): Promise<T> {
  if (!isUuidV7(request.key)) throw new SupportStoreError('INVALID');
  const now = Date.now();
  return transactMockStoreJson(fileName(ownerId), (raw) => {
    const state = parseState(raw ?? supportSeed(ownerId), ownerId);
    const commands = state.commands.filter((command) => Date.parse(command.expiresAt) > now);
    const existing = commands.find((command) => command.key === request.key);
    if (existing) {
      if (existing.kind !== request.kind || existing.fingerprint !== request.fingerprint) {
        throw new SupportStoreError('IDEMPOTENCY_CONFLICT');
      }
      return { result: structuredClone(existing.result) as T };
    }
    if (commands.length >= MAX_COMMANDS) throw new SupportStoreError('CAPACITY');
    const mutable: MutableSupportState = {
      messages: [...structuredClone(state.messages)],
      tickets: [...structuredClone(state.tickets)],
      feedback: [...structuredClone(state.feedback)],
    };
    const result = mutate(mutable);
    const next = parseState(
      {
        ...state,
        messages: mutable.messages,
        tickets: mutable.tickets,
        feedback: mutable.feedback,
        commands: [
          ...commands,
          {
            key: request.key,
            kind: request.kind,
            fingerprint: request.fingerprint,
            result: structuredClone(result),
            expiresAt: new Date(now + COMMAND_TTL_MS).toISOString(),
          },
        ],
      },
      ownerId,
    );
    return { result, next };
  });
}

type SupportCommandReplay =
  { readonly found: false } | { readonly found: true; readonly result: unknown };

export async function replaySupportCommand(
  ownerId: string,
  request: { readonly key: string; readonly kind: CommandKind; readonly fingerprint: string },
): Promise<SupportCommandReplay> {
  if (!isUuidV7(request.key)) throw new SupportStoreError('INVALID');
  return transactMockStoreJson<SupportCommandReplay>(fileName(ownerId), (raw) => {
    if (raw === undefined) return { result: { found: false } as const };
    const state = parseState(raw, ownerId);
    const existing = state.commands.find(
      ({ key, expiresAt }) => key === request.key && Date.parse(expiresAt) > Date.now(),
    );
    if (!existing) return { result: { found: false } as const };
    if (existing.kind !== request.kind || existing.fingerprint !== request.fingerprint) {
      throw new SupportStoreError('IDEMPOTENCY_CONFLICT');
    }
    return {
      result: { found: true, result: structuredClone(existing.result) } as const,
    };
  });
}
