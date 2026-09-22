export type TicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';
export type MessageKind = 'TASK' | 'PAYMENT' | 'BALANCE' | 'SYSTEM';

export interface CursorPageInfo {
  readonly previousCursor?: string;
  readonly nextCursor?: string;
}

export interface MessageView {
  readonly id: string;
  readonly kind: MessageKind;
  readonly title: string;
  readonly summary: string;
  readonly occurredAt: string;
  readonly readAt?: string;
  readonly deepLink?: string;
}

export interface MessagePage {
  readonly items: readonly MessageView[];
  readonly unreadCount: number;
  readonly pageInfo: CursorPageInfo;
}

export interface MessageFilters {
  readonly state?: 'ALL' | 'UNREAD';
  readonly kind?: MessageKind;
  readonly cursor?: string;
}

export interface TicketAttachmentView {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
}

export interface TicketReplyView {
  readonly id: string;
  readonly author: 'USER' | 'SUPPORT';
  readonly body: string;
  readonly createdAt: string;
  readonly attachments: readonly TicketAttachmentView[];
}

export interface TicketStatusHistoryView {
  readonly status: TicketStatus;
  readonly occurredAt: string;
  readonly label: string;
}

export interface TicketSatisfactionView {
  readonly rating: 1 | 2 | 3 | 4 | 5;
  readonly comment?: string;
  readonly createdAt: string;
}

export type FeedbackKind = 'MODEL_RESULT' | 'FAILED_TASK' | 'PRODUCT_SUGGESTION';

export interface FeedbackView {
  readonly id: string;
  readonly kind: FeedbackKind;
  readonly body: string;
  readonly referenceId?: string;
  readonly createdAt: string;
}

export interface TicketView {
  readonly id: string;
  readonly subject: string;
  readonly category: 'TASK' | 'PAYMENT' | 'ACCOUNT' | 'SUGGESTION' | 'OTHER';
  readonly status: TicketStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly replies: readonly TicketReplyView[];
  readonly statusHistory: readonly TicketStatusHistoryView[];
  readonly canClose: boolean;
  readonly canReopen: boolean;
  readonly reopenUntil?: string;
  readonly satisfaction?: TicketSatisfactionView;
}

export interface TicketPage {
  readonly items: readonly TicketView[];
  readonly pageInfo: CursorPageInfo;
}

export interface TicketFilters {
  readonly status?: TicketStatus;
  readonly cursor?: string;
}

export type SupportCommandOutcome = 'DEFINITIVE_FAILURE' | 'UNCERTAIN' | 'SESSION_REFRESH_REQUIRED';

export type SupportActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly outcome: SupportCommandOutcome };

export interface SupportGateway {
  listMessages(filters: MessageFilters, context: { readonly ownerId: string }): Promise<unknown>;
  markMessagesRead(
    ids: readonly string[],
    context: { readonly ownerId: string; readonly idempotencyKey: string },
  ): Promise<unknown>;
  listTickets(filters: TicketFilters, context: { readonly ownerId: string }): Promise<unknown>;
  createTicket(
    input: {
      readonly subject: string;
      readonly category: TicketView['category'];
      readonly body: string;
      readonly attachmentIds: readonly string[];
    },
    context: { readonly ownerId: string; readonly idempotencyKey: string },
  ): Promise<unknown>;
  replyTicket(
    ticketId: string,
    input: { readonly body: string; readonly attachmentIds: readonly string[] },
    context: { readonly ownerId: string; readonly idempotencyKey: string },
  ): Promise<unknown>;
  changeTicketStatus(
    ticketId: string,
    action: 'CLOSE' | 'REOPEN',
    context: { readonly ownerId: string; readonly idempotencyKey: string },
  ): Promise<unknown>;
  submitTicketSatisfaction(
    ticketId: string,
    input: { readonly rating: number; readonly comment?: string },
    context: { readonly ownerId: string; readonly idempotencyKey: string },
  ): Promise<unknown>;
  submitFeedback(
    input: {
      readonly kind: FeedbackKind;
      readonly body: string;
      readonly referenceId?: string;
    },
    context: { readonly ownerId: string; readonly idempotencyKey: string },
  ): Promise<unknown>;
}
