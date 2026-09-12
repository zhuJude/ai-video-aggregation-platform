'use server';

import {
  AuthenticationRequiredError,
  requireMutableAuthenticatedServerSession,
  SessionRefreshRequiredError,
} from '../lib/auth/server-session';
import { supportGateway, SupportGatewayError } from '../lib/support/gateway';
import { parseTicketPage } from '../lib/support/runtime';
import type { SupportActionResult, TicketView } from '../lib/support/types';
import { isUuidV7 } from '../lib/tasks/identifiers';

function failure(error: unknown): SupportActionResult<never> {
  if (error instanceof SessionRefreshRequiredError)
    return { ok: false, outcome: 'SESSION_REFRESH_REQUIRED' };
  if (error instanceof AuthenticationRequiredError || error instanceof SupportGatewayError)
    return { ok: false, outcome: 'DEFINITIVE_FAILURE' };
  return { ok: false, outcome: 'UNCERTAIN' };
}

async function ownerId(): Promise<string> {
  return (await requireMutableAuthenticatedServerSession()).ownerId;
}

function ticket(value: unknown): TicketView {
  const parsed = parseTicketPage({ items: [value], pageInfo: {} }).items[0];
  if (!parsed) throw new Error('INVALID_TICKET_RESULT');
  return parsed;
}

function safeAttachmentIds(value: readonly string[]): readonly string[] {
  const attachmentIds: readonly string[] = value;
  if (
    !Array.isArray(value) ||
    value.length > 5 ||
    new Set(value).size !== value.length ||
    value.some((id) => !isUuidV7(id))
  )
    throw new Error('INVALID_ATTACHMENTS');
  return attachmentIds;
}

export async function markMessagesReadAction(
  ids: readonly string[],
  idempotencyKey: string,
): Promise<SupportActionResult<{ readonly readAt: string }>> {
  try {
    const result = await supportGateway.markMessagesRead(ids, {
      ownerId: await ownerId(),
      idempotencyKey,
    });
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      !('readAt' in result) ||
      typeof result.readAt !== 'string' ||
      !Number.isFinite(Date.parse(result.readAt))
    )
      throw new Error('INVALID_MESSAGE_READ_RESULT');
    return { ok: true, data: { readAt: result.readAt } };
  } catch (error) {
    return failure(error);
  }
}

export async function createTicketAction(
  input: {
    readonly subject: string;
    readonly category: TicketView['category'];
    readonly body: string;
    readonly attachmentIds: readonly string[];
  },
  idempotencyKey: string,
): Promise<SupportActionResult<TicketView>> {
  try {
    return {
      ok: true,
      data: ticket(
        await supportGateway.createTicket(
          { ...input, attachmentIds: safeAttachmentIds(input.attachmentIds) },
          { ownerId: await ownerId(), idempotencyKey },
        ),
      ),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function replyTicketAction(
  ticketId: string,
  input: { readonly body: string; readonly attachmentIds: readonly string[] },
  idempotencyKey: string,
): Promise<SupportActionResult<TicketView>> {
  try {
    return {
      ok: true,
      data: ticket(
        await supportGateway.replyTicket(
          ticketId,
          { ...input, attachmentIds: safeAttachmentIds(input.attachmentIds) },
          {
            ownerId: await ownerId(),
            idempotencyKey,
          },
        ),
      ),
    };
  } catch (error) {
    return failure(error);
  }
}

export async function changeTicketStatusAction(
  ticketId: string,
  action: 'CLOSE' | 'REOPEN',
  idempotencyKey: string,
): Promise<SupportActionResult<TicketView>> {
  try {
    return {
      ok: true,
      data: ticket(
        await supportGateway.changeTicketStatus(ticketId, action, {
          ownerId: await ownerId(),
          idempotencyKey,
        }),
      ),
    };
  } catch (error) {
    return failure(error);
  }
}
