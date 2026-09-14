/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unnecessary-type-assertion -- in-memory repository preserves the production async port. */
import { EventEnvelopeSchema, PointsStringSchema } from '@repo/contracts/common';
import { TaskStatusSchema } from '@repo/contracts/generation';
import { PaymentStatusSchema } from '@repo/contracts/payment';
import type { SmsReceiptResult, SmsSendInput, SmsSender } from '../ports/sms-sender.js';
import { createUuidV7Generator, UUID_V7_PATTERN } from '../domain/uuid-v7.js';

export type NotificationChannel = 'IN_APP' | 'SMS';
export type NotificationStatus =
  'PENDING' | 'RECONCILING' | 'RETRY_PENDING' | 'DELIVERED' | 'OPERATOR_REVIEW';

export class NotificationError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
  ) {
    super(code);
    this.name = 'NotificationError';
  }
}

export interface TemplateVersion {
  id: string;
  templateKey: string;
  version: number;
  declaredVariables: readonly string[];
  inAppTitle: string;
  inAppBody: string;
  smsBody: string;
  smsSignName: string;
  smsTemplateCode: string;
  publishedAt: Date;
}

export interface NotificationRecord {
  id: string;
  eventId: string;
  userId: string;
  channel: NotificationChannel;
  templateVersionId: string;
  renderedTitle: string | null;
  renderedBody: string;
  variables: Readonly<Record<string, string>>;
  phoneE164: string | null;
  signName: string | null;
  templateCode: string | null;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: Date;
  claimToken: string | null;
  leaseUntil: Date | null;
  providerRequestId: string | null;
  providerReceipt: string | null;
  providerReceiptStatus:
    'ACCEPTED' | 'UNKNOWN_ACCEPTANCE' | 'PENDING' | 'DELIVERED' | 'FAILED' | null;
  reconciliationAttempts: number;
  sendStartedAt: Date | null;
  sendDate: string | null;
  createdAt: Date;
  deliveryMode?: 'SEND' | 'RECONCILE';
}

export interface InboxMessage {
  id: string;
  notificationId: string;
  userId: string;
  title: string;
  body: string;
  readAt: Date | null;
  createdAt: Date;
}

interface AcceptedNotification {
  template: TemplateVersion;
  eventId: string;
  eventType: string;
  userId: string;
  phoneE164: string | null;
  variables: Readonly<Record<string, string>>;
  channels: readonly NotificationChannel[];
  rendered: Readonly<Record<NotificationChannel, { title: string | null; body: string }>>;
  occurredAt: Date;
  processedAt: Date;
  correlationId: string;
  causationId: string | null;
  traceId: string;
  id: () => string;
}

export interface NotificationRepository {
  publishTemplate(input: Omit<TemplateVersion, 'version'>): Promise<TemplateVersion>;
  latestTemplate(key: string): Promise<TemplateVersion | null>;
  hasProcessedEvent(eventId: string): Promise<boolean>;
  acceptEvent(input: AcceptedNotification): Promise<boolean>;
  claim(now: Date, claimToken: string, leaseUntil: Date): Promise<NotificationRecord | null>;
  accepted(
    id: string,
    claimToken: string,
    result: { requestId: string; receipt: string },
    nextAttemptAt: Date,
    now: Date,
  ): Promise<void>;
  unknownAcceptance(
    id: string,
    claimToken: string,
    nextAttemptAt: Date,
    code: string,
    now: Date,
  ): Promise<void>;
  reconciliationPending(
    id: string,
    claimToken: string,
    result: { requestId?: string; receipt?: string },
    nextAttemptAt: Date,
    code: string,
    now: Date,
  ): Promise<void>;
  complete(id: string, claimToken: string, result: SmsReceiptResult, now: Date): Promise<void>;
  confirmNotAccepted(
    id: string,
    claimToken: string,
    result: SmsReceiptResult,
    nextAttemptAt: Date,
    now: Date,
  ): Promise<void>;
  retry(
    id: string,
    claimToken: string,
    nextAttemptAt: Date,
    code: string,
    now: Date,
  ): Promise<void>;
  operatorReview(id: string, claimToken: string, code: string, now: Date): Promise<void>;
  listInbox(
    userId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: InboxMessage[]; nextCursor?: string }>;
  markRead(userId: string, messageId: string, now: Date): Promise<InboxMessage | null>;
}

export class TemplateService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly id: () => string = createUuidV7Generator(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async publish(
    input: Omit<TemplateVersion, 'id' | 'version' | 'publishedAt'>,
  ): Promise<TemplateVersion> {
    validateTemplate(input);
    return this.repository.publishTemplate({ ...input, id: this.id(), publishedAt: this.now() });
  }

  async render(
    key: string,
    variables: Readonly<Record<string, string>>,
    channel: NotificationChannel,
  ): Promise<{ template: TemplateVersion; title: string | null; body: string }> {
    const template = await this.repository.latestTemplate(key);
    if (template === null) throw new NotificationError('TEMPLATE_NOT_FOUND');
    validateVariables(template.declaredVariables, variables);
    const title = channel === 'IN_APP' ? substitute(template.inAppTitle, variables) : null;
    const source = channel === 'IN_APP' ? template.inAppBody : template.smsBody;
    return { template, title, body: substitute(source, variables) };
  }

  async renderSnapshot(
    key: string,
    variables: Readonly<Record<string, string>>,
  ): Promise<{
    template: TemplateVersion;
    rendered: Readonly<Record<NotificationChannel, { title: string | null; body: string }>>;
  }> {
    const template = await this.repository.latestTemplate(key);
    if (template === null) throw new NotificationError('TEMPLATE_NOT_FOUND');
    validateVariables(template.declaredVariables, variables);
    return {
      template,
      rendered: {
        IN_APP: {
          title: substitute(template.inAppTitle, variables),
          body: substitute(template.inAppBody, variables),
        },
        SMS: { title: null, body: substitute(template.smsBody, variables) },
      },
    };
  }
}

const SUPPORTED_EVENTS = new Set([
  'task.succeeded.v1',
  'task.failed.v1',
  'payment.succeeded.v1',
  'payment.failed.v1',
  'ticket.replied.v1',
  'wallet.low-balance.v1',
]);

interface ParsedEvent {
  id: string;
  eventType: string;
  occurredAt: Date;
  correlationId: string;
  causationId: string | null;
  traceId: string;
  data: {
    userId: string;
    phoneE164: string | null;
    templateKey: string;
    variables: Record<string, string>;
    channels: NotificationChannel[];
  };
}

export class NotificationConsumer {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly templates: TemplateService,
    private readonly worker: NotificationWorker,
    private readonly options: { id?: () => string; now?: () => Date } = {},
  ) {}

  async handle(raw: unknown): Promise<void> {
    const event = parseEnvelope(raw);
    if (await this.repository.hasProcessedEvent(event.id)) return;
    const snapshot = await this.templates.renderSnapshot(
      event.data.templateKey,
      event.data.variables,
    );
    const accepted = await this.repository.acceptEvent({
      template: snapshot.template,
      eventId: event.id,
      eventType: event.eventType,
      userId: event.data.userId,
      phoneE164: event.data.phoneE164,
      variables: event.data.variables,
      channels: event.data.channels,
      rendered: snapshot.rendered,
      occurredAt: event.occurredAt,
      processedAt: (this.options.now ?? (() => new Date()))(),
      correlationId: event.correlationId,
      causationId: event.causationId,
      traceId: event.traceId,
      id: this.options.id ?? createUuidV7Generator(),
    });
    if (accepted && event.data.channels.includes('SMS')) await this.worker.runOnce();
  }
}

export class NotificationWorker {
  private readonly id: () => string;
  private readonly now: () => Date;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly leaseMs: number;

  constructor(
    private readonly repository: NotificationRepository,
    private readonly sender: SmsSender,
    options: {
      id?: () => string;
      now?: () => Date;
      maxAttempts?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
      leaseMs?: number;
    } = {},
  ) {
    this.id = options.id ?? createUuidV7Generator();
    this.now = options.now ?? (() => new Date());
    this.maxAttempts = options.maxAttempts ?? 6;
    this.baseDelayMs = options.baseDelayMs ?? 5_000;
    this.maxDelayMs = options.maxDelayMs ?? 15 * 60_000;
    this.leaseMs = options.leaseMs ?? 30_000;
  }

  async runOnce(): Promise<boolean> {
    const claimTime = this.now();
    const claimToken = this.id();
    const item = await this.repository.claim(
      claimTime,
      claimToken,
      new Date(claimTime.getTime() + this.leaseMs),
    );
    if (item === null) return false;
    const input = smsInput(item);
    const mode = item.deliveryMode ?? (item.status === 'RECONCILING' ? 'RECONCILE' : 'SEND');
    if (mode === 'SEND') {
      let result: Awaited<ReturnType<SmsSender['send']>>;
      try {
        result = await this.sender.send(input);
      } catch (error) {
        const failedAt = this.now();
        if (wasNotAttempted(error))
          await this.handleProviderFailure(item, claimToken, failedAt, error, false);
        else
          await this.repository.unknownAcceptance(
            item.id,
            claimToken,
            new Date(failedAt.getTime() + this.baseDelayMs),
            failureCode(error),
            failedAt,
          );
        return true;
      }
      // Intentionally outside the provider catch. If persistence fails after provider
      // acceptance, the unfinished attempt and RECONCILING lease recover by receipt lookup.
      const acceptedAt = this.now();
      await this.repository.accepted(
        item.id,
        claimToken,
        result,
        new Date(acceptedAt.getTime() + this.baseDelayMs),
        acceptedAt,
      );
      return true;
    }
    let result: SmsReceiptResult;
    try {
      result = await this.sender.reconcile({
        ...input,
        ...(item.providerRequestId === null ? {} : { requestId: item.providerRequestId }),
        ...(item.providerReceipt === null ? {} : { receipt: item.providerReceipt }),
      });
    } catch (error) {
      await this.handleProviderFailure(item, claimToken, this.now(), error, true);
      return true;
    }
    const completedAt = this.now();
    if (result.status === 'PENDING') {
      if (item.reconciliationAttempts >= this.maxAttempts)
        await this.repository.operatorReview(
          item.id,
          claimToken,
          'RECONCILIATION_EXHAUSTED',
          completedAt,
        );
      else
        await this.repository.reconciliationPending(
          item.id,
          claimToken,
          result,
          new Date(
            completedAt.getTime() +
              computeBackoffDelay(item.reconciliationAttempts, this.baseDelayMs, this.maxDelayMs),
          ),
          'RECEIPT_PENDING',
          completedAt,
        );
    } else if (result.status === 'FAILED')
      await this.repository.operatorReview(item.id, claimToken, 'PROVIDER_REJECTED', completedAt);
    else if (result.status === 'NOT_ACCEPTED')
      await this.repository.confirmNotAccepted(
        item.id,
        claimToken,
        result,
        new Date(
          completedAt.getTime() +
            computeBackoffDelay(item.attempts, this.baseDelayMs, this.maxDelayMs),
        ),
        completedAt,
      );
    else await this.repository.complete(item.id, claimToken, result, completedAt);
    return true;
  }

  private async handleProviderFailure(
    item: NotificationRecord,
    claimToken: string,
    now: Date,
    error: unknown,
    reconciling: boolean,
  ): Promise<void> {
    const exhausted = reconciling
      ? item.reconciliationAttempts >= this.maxAttempts
      : item.attempts >= this.maxAttempts;
    if (isPermanent(error) || exhausted) {
      await this.repository.operatorReview(
        item.id,
        claimToken,
        reconciling && exhausted ? 'RECONCILIATION_EXHAUSTED' : failureCode(error),
        now,
      );
      return;
    }
    const delay = computeBackoffDelay(
      reconciling ? item.reconciliationAttempts : item.attempts,
      this.baseDelayMs,
      this.maxDelayMs,
    );
    if (reconciling)
      await this.repository.reconciliationPending(
        item.id,
        claimToken,
        {
          ...(item.providerRequestId === null ? {} : { requestId: item.providerRequestId }),
          ...(item.providerReceipt === null ? {} : { receipt: item.providerReceipt }),
        },
        new Date(now.getTime() + delay),
        failureCode(error),
        now,
      );
    else
      await this.repository.retry(
        item.id,
        claimToken,
        new Date(now.getTime() + delay),
        failureCode(error),
        now,
      );
  }
}

export class NotificationWorkerRunner {
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<void> = Promise.resolve();

  constructor(
    private readonly worker: Pick<NotificationWorker, 'runOnce'>,
    private readonly options: {
      intervalMs?: number;
      stopTimeoutMs?: number;
      onError?: (error: unknown) => void;
    } = {},
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(finish, this.options.stopTimeoutMs ?? 25_000);
      void this.inFlight.then(finish, finish);
    });
  }

  private schedule(delay: number): void {
    this.timer = setTimeout(() => {
      this.inFlight = this.tick();
    }, delay);
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    let didWork = false;
    try {
      didWork = await this.worker.runOnce();
    } catch (error) {
      this.options.onError?.(error);
    }
    if (this.isRunning()) this.schedule(didWork ? 0 : (this.options.intervalMs ?? 1_000));
  }

  private isRunning(): boolean {
    return this.running;
  }
}

export function computeBackoffDelay(
  attempt: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  return Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

export class NotificationService {
  constructor(
    private readonly repository: NotificationRepository,
    private readonly now: () => Date = () => new Date(),
  ) {}
  listInbox(
    userId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: InboxMessage[]; nextCursor?: string }> {
    if (
      !UUID_V7_PATTERN.test(userId) ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 100
    )
      throw new NotificationError('INVALID_REQUEST');
    return this.repository.listInbox(userId, input);
  }
  async markRead(userId: string, messageId: string): Promise<InboxMessage> {
    if (!UUID_V7_PATTERN.test(userId) || !UUID_V7_PATTERN.test(messageId))
      throw new NotificationError('INVALID_REQUEST');
    const result = await this.repository.markRead(userId, messageId, this.now());
    if (result === null) throw new NotificationError('INBOX_MESSAGE_NOT_FOUND');
    return result;
  }
}

export class InMemoryNotificationRepository implements NotificationRepository {
  private readonly templates: TemplateVersion[] = [];
  private readonly notifications = new Map<string, NotificationRecord>();
  private readonly events = new Set<string>();
  private readonly inbox = new Map<string, InboxMessage>();
  private readonly operator = new Map<string, { notificationId: string; code: string }>();
  private failFinalize = false;

  async publishTemplate(input: Omit<TemplateVersion, 'version'>): Promise<TemplateVersion> {
    const version =
      this.templates.filter((item) => item.templateKey === input.templateKey).length + 1;
    const result = { ...input, version };
    this.templates.push(result);
    return structuredClone(result);
  }
  async latestTemplate(key: string): Promise<TemplateVersion | null> {
    return structuredClone(
      this.templates.filter((item) => item.templateKey === key).at(-1) ?? null,
    );
  }
  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return this.events.has(eventId);
  }
  async acceptEvent(input: AcceptedNotification): Promise<boolean> {
    if (this.events.has(input.eventId)) return false;
    this.events.add(input.eventId);
    for (const channel of new Set(input.channels)) {
      const rendered = input.rendered[channel];
      const notification: NotificationRecord = {
        id: input.id(),
        eventId: input.eventId,
        userId: input.userId,
        channel,
        templateVersionId: input.template.id,
        renderedTitle: rendered.title,
        renderedBody: rendered.body,
        variables: structuredClone(input.variables),
        phoneE164: channel === 'SMS' ? input.phoneE164 : null,
        signName: channel === 'SMS' ? input.template.smsSignName : null,
        templateCode: channel === 'SMS' ? input.template.smsTemplateCode : null,
        status: channel === 'SMS' ? 'PENDING' : 'DELIVERED',
        attempts: 0,
        nextAttemptAt: input.occurredAt,
        claimToken: null,
        leaseUntil: null,
        providerRequestId: null,
        providerReceipt: null,
        providerReceiptStatus: null,
        reconciliationAttempts: 0,
        sendStartedAt: null,
        sendDate: null,
        createdAt: input.occurredAt,
      };
      this.notifications.set(notification.id, notification);
      if (channel === 'IN_APP') {
        const message: InboxMessage = {
          id: input.id(),
          notificationId: notification.id,
          userId: input.userId,
          title: rendered.title ?? '',
          body: rendered.body,
          readAt: null,
          createdAt: input.occurredAt,
        };
        this.inbox.set(message.id, message);
      }
    }
    return true;
  }
  async claim(now: Date, claimToken: string, leaseUntil: Date): Promise<NotificationRecord | null> {
    const eligible = [...this.notifications.values()]
      .filter(
        (item) =>
          item.channel === 'SMS' &&
          (((item.status === 'PENDING' || item.status === 'RETRY_PENDING') &&
            item.nextAttemptAt <= now) ||
            (item.status === 'RECONCILING' &&
              item.nextAttemptAt <= now &&
              (item.leaseUntil === null || item.leaseUntil <= now))),
      )
      .sort(
        (a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime() || a.id.localeCompare(b.id),
      )[0];
    if (eligible === undefined) return null;
    const previousStatus = eligible.status;
    const deliveryMode =
      previousStatus === 'RECONCILING' || eligible.providerReceiptStatus !== null
        ? 'RECONCILE'
        : 'SEND';
    eligible.status = 'RECONCILING';
    eligible.claimToken = claimToken;
    eligible.leaseUntil = leaseUntil;
    if (previousStatus !== 'RECONCILING') eligible.attempts += 1;
    if (deliveryMode === 'SEND') {
      eligible.sendStartedAt = now;
      eligible.sendDate = formatSmsSendDate(now);
    } else eligible.reconciliationAttempts += 1;
    return structuredClone({ ...eligible, status: previousStatus, deliveryMode });
  }
  async accepted(
    id: string,
    claimToken: string,
    result: { requestId: string; receipt: string },
    nextAttemptAt: Date,
  ): Promise<void> {
    const item = this.claimed(id, claimToken);
    if (this.failFinalize) {
      this.failFinalize = false;
      item.leaseUntil = new Date(0);
      throw new Error('SIMULATED_DATABASE_FAILURE');
    }
    item.providerRequestId = result.requestId;
    item.providerReceipt = result.receipt;
    item.providerReceiptStatus = 'ACCEPTED';
    item.nextAttemptAt = nextAttemptAt;
    item.claimToken = null;
    item.leaseUntil = null;
  }
  async unknownAcceptance(id: string, claimToken: string, nextAttemptAt: Date): Promise<void> {
    const item = this.claimed(id, claimToken);
    item.status = 'RECONCILING';
    item.providerReceiptStatus = 'UNKNOWN_ACCEPTANCE';
    item.nextAttemptAt = nextAttemptAt;
    item.claimToken = null;
    item.leaseUntil = null;
  }
  async reconciliationPending(
    id: string,
    claimToken: string,
    result: { requestId?: string; receipt?: string },
    nextAttemptAt: Date,
  ): Promise<void> {
    const item = this.claimed(id, claimToken);
    if (result.requestId !== undefined) item.providerRequestId = result.requestId;
    if (result.receipt !== undefined) item.providerReceipt = result.receipt;
    item.providerReceiptStatus = 'PENDING';
    item.nextAttemptAt = nextAttemptAt;
    item.claimToken = null;
    item.leaseUntil = null;
  }
  async complete(id: string, claimToken: string, result: SmsReceiptResult): Promise<void> {
    const item = this.claimed(id, claimToken);
    item.providerRequestId = result.requestId;
    if (result.receipt !== undefined) item.providerReceipt = result.receipt;
    item.providerReceiptStatus = 'DELIVERED';
    item.status = 'DELIVERED';
    item.claimToken = null;
    item.leaseUntil = null;
  }
  async retry(id: string, claimToken: string, nextAttemptAt: Date): Promise<void> {
    const item = this.claimed(id, claimToken);
    item.status = 'RETRY_PENDING';
    item.nextAttemptAt = nextAttemptAt;
    item.claimToken = null;
    item.leaseUntil = null;
  }
  async confirmNotAccepted(
    id: string,
    claimToken: string,
    _result: SmsReceiptResult,
    nextAttemptAt: Date,
  ): Promise<void> {
    const item = this.claimed(id, claimToken);
    item.status = 'RETRY_PENDING';
    item.providerRequestId = null;
    item.providerReceipt = null;
    item.providerReceiptStatus = null;
    item.nextAttemptAt = nextAttemptAt;
    item.claimToken = null;
    item.leaseUntil = null;
  }
  async operatorReview(id: string, claimToken: string, code: string): Promise<void> {
    const item = this.claimed(id, claimToken);
    item.status = 'OPERATOR_REVIEW';
    item.claimToken = null;
    item.leaseUntil = null;
    this.operator.set(id, { notificationId: id, code });
  }
  async listInbox(
    userId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: InboxMessage[]; nextCursor?: string }> {
    const decoded = input.cursor === undefined ? null : decodeCursor(input.cursor);
    const all = [...this.inbox.values()]
      .filter(
        (item) =>
          item.userId === userId &&
          (decoded === null ||
            item.createdAt < decoded.createdAt ||
            (item.createdAt.getTime() === decoded.createdAt.getTime() && item.id < decoded.id)),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    const items = all.slice(0, input.limit).map((item) => structuredClone(item));
    const last = items.at(-1);
    return {
      items,
      ...(all.length > input.limit && last !== undefined ? { nextCursor: encodeCursor(last) } : {}),
    };
  }
  async markRead(userId: string, messageId: string, now: Date): Promise<InboxMessage | null> {
    const item = this.inbox.get(messageId);
    if (item === undefined || item.userId !== userId) return null;
    item.readAt ??= now;
    return structuredClone(item);
  }
  async countInboxMessages(userId: string): Promise<number> {
    return [...this.inbox.values()].filter((item) => item.userId === userId).length;
  }
  async listNotifications(): Promise<NotificationRecord[]> {
    return structuredClone([...this.notifications.values()]);
  }
  async listOperatorQueue(): Promise<{ notificationId: string; code: string }[]> {
    return structuredClone([...this.operator.values()]);
  }
  failNextFinalize(): void {
    this.failFinalize = true;
  }
  private claimed(id: string, token: string): NotificationRecord {
    const item = this.notifications.get(id);
    if (item === undefined || item.claimToken !== token)
      throw new NotificationError('LEASE_LOST', true);
    return item;
  }
}

function validateTemplate(input: Omit<TemplateVersion, 'id' | 'version' | 'publishedAt'>): void {
  if (
    !/^[a-z0-9][a-z0-9-]{1,127}$/.test(input.templateKey) ||
    !/^SMS_[0-9]{6,20}$/.test(input.smsTemplateCode) ||
    input.smsSignName.length < 1
  )
    throw new NotificationError('INVALID_TEMPLATE');
  if (
    new Set(input.declaredVariables).size !== input.declaredVariables.length ||
    input.declaredVariables.some(
      (name) =>
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ||
        ['constructor', 'prototype', '__proto__'].includes(name),
    )
  )
    throw new NotificationError('UNSAFE_TEMPLATE');
  for (const source of [input.inAppTitle, input.inAppBody, input.smsBody]) {
    if (
      source.includes('{{{') ||
      source.includes('}}}') ||
      /\{\{\s*[^A-Za-z][^}]*\}\}/.test(source) ||
      /\$\{[^A-Za-z][^}]*\}/.test(source)
    )
      throw new NotificationError('UNSAFE_TEMPLATE');
    const referenced = placeholders(source);
    if (referenced.some((name) => !input.declaredVariables.includes(name)))
      throw new NotificationError('UNSAFE_TEMPLATE');
    const residue = source.replace(
      /\{\{\s*[A-Za-z][A-Za-z0-9_]*\s*\}\}|\$\{[A-Za-z][A-Za-z0-9_]*\}/g,
      '',
    );
    if (/[{}]/.test(residue)) throw new NotificationError('UNSAFE_TEMPLATE');
  }
}

function validateVariables(
  declared: readonly string[],
  variables: Readonly<Record<string, string>>,
): void {
  const keys = Object.keys(variables);
  if (keys.some((key) => !declared.includes(key)))
    throw new NotificationError('UNKNOWN_TEMPLATE_VARIABLE');
  if (declared.some((key) => !Object.hasOwn(variables, key)))
    throw new NotificationError('MISSING_TEMPLATE_VARIABLE');
  if (
    keys.some(
      (key) =>
        typeof variables[key] !== 'string' ||
        ['constructor', 'prototype', '__proto__'].includes(key),
    )
  )
    throw new NotificationError('UNSAFE_TEMPLATE_VARIABLE');
}

function placeholders(source: string): string[] {
  return [
    ...source.matchAll(/\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}|\$\{([A-Za-z][A-Za-z0-9_]*)\}/g),
  ].map((match) => match[1] ?? match[2] ?? '');
}
function substitute(source: string, variables: Readonly<Record<string, string>>): string {
  return source.replace(
    /\{\{\s*([A-Za-z][A-Za-z0-9_]*)\s*\}\}|\$\{([A-Za-z][A-Za-z0-9_]*)\}/g,
    (_match, first: string | undefined, second: string | undefined) =>
      variables[first ?? second ?? ''] ?? '',
  );
}

function parseEnvelope(raw: unknown): ParsedEvent {
  if (!isRecord(raw)) throw new NotificationError('INVALID_EVENT_ENVELOPE');
  if (typeof raw.version === 'number' && Number.isInteger(raw.version) && raw.version > 1)
    throw new NotificationError('UNSUPPORTED_CONTRACT_VERSION');
  const result = EventEnvelopeSchema.strict().safeParse(raw);
  if (!result.success) throw new NotificationError('INVALID_EVENT_ENVELOPE');
  const envelope = result.data;
  if (!SUPPORTED_EVENTS.has(envelope.type)) throw new NotificationError('UNSUPPORTED_EVENT_TYPE');
  const data = parsePayload(envelope.type, envelope.data);
  return {
    id: envelope.id,
    eventType: envelope.type,
    occurredAt: new Date(envelope.occurredAt),
    correlationId: envelope.correlationId,
    causationId: envelope.causationId ?? null,
    traceId: envelope.traceId,
    data,
  };
}

function parsePayload(eventType: string, raw: unknown): ParsedEvent['data'] {
  if (!isRecord(raw)) throw new NotificationError('INVALID_EVENT_PAYLOAD');
  const common = ['userId', 'phoneE164', 'templateKey', 'variables', 'channels'];
  const domain = eventType.startsWith('task.')
    ? ['taskId', 'status']
    : eventType.startsWith('payment.')
      ? ['paymentId', 'status']
      : eventType.startsWith('ticket.')
        ? ['ticketId', 'messageId']
        : ['walletId', 'availablePoints'];
  const exact = [...common, ...domain];
  if (
    Object.keys(raw).some((key) => !exact.includes(key)) ||
    exact.some((key) => !Object.hasOwn(raw, key))
  )
    throw new NotificationError('INVALID_EVENT_PAYLOAD');
  if (
    !uuid(raw.userId) ||
    typeof raw.templateKey !== 'string' ||
    raw.templateKey.length === 0 ||
    !isRecord(raw.variables) ||
    !Array.isArray(raw.channels) ||
    raw.channels.length === 0 ||
    raw.channels.some((channel) => channel !== 'IN_APP' && channel !== 'SMS') ||
    (raw.phoneE164 !== null && typeof raw.phoneE164 !== 'string') ||
    !validDomainPayload(eventType, raw)
  )
    throw new NotificationError('INVALID_EVENT_PAYLOAD');
  const variables: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw.variables)) {
    if (typeof value !== 'string') throw new NotificationError('INVALID_EVENT_PAYLOAD');
    variables[key] = value;
  }
  if (
    raw.channels.includes('SMS') &&
    (typeof raw.phoneE164 !== 'string' || !/^\+[1-9]\d{7,14}$/.test(raw.phoneE164))
  )
    throw new NotificationError('INVALID_EVENT_PAYLOAD');
  return {
    userId: raw.userId,
    phoneE164: raw.phoneE164 as string | null,
    templateKey: raw.templateKey,
    variables,
    channels: [...new Set(raw.channels)] as NotificationChannel[],
  };
}

function validDomainPayload(eventType: string, data: Record<string, unknown>): boolean {
  if (eventType.startsWith('task.'))
    return (
      uuid(data.taskId) &&
      TaskStatusSchema.safeParse(data.status).success &&
      data.status === (eventType.includes('succeeded') ? 'SUCCEEDED' : 'FAILED')
    );
  if (eventType.startsWith('payment.'))
    return (
      uuid(data.paymentId) &&
      PaymentStatusSchema.safeParse(data.status).success &&
      data.status === (eventType.includes('succeeded') ? 'PAID' : 'FAILED')
    );
  if (eventType.startsWith('ticket.')) return uuid(data.ticketId) && uuid(data.messageId);
  return uuid(data.walletId) && PointsStringSchema.safeParse(data.availablePoints).success;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_V7_PATTERN.test(value);
}
function utc(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}
function smsInput(item: NotificationRecord): SmsSendInput {
  if (
    item.phoneE164 === null ||
    item.signName === null ||
    item.templateCode === null ||
    item.sendStartedAt === null ||
    item.sendDate === null
  )
    throw new NotificationError('INVALID_SMS_NOTIFICATION');
  return {
    notificationId: item.id,
    phoneE164: item.phoneE164,
    signName: item.signName,
    templateCode: item.templateCode,
    variables: item.variables,
    sendStartedAt: item.sendStartedAt,
    sendDate: item.sendDate,
  };
}
function formatSmsSendDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}
function isPermanent(error: unknown): boolean {
  return isRecord(error) && error.kind === 'PERMANENT';
}
function wasNotAttempted(error: unknown): boolean {
  return isRecord(error) && error.acceptance === 'NOT_ATTEMPTED';
}
function failureCode(error: unknown): string {
  return isRecord(error) && typeof error.code === 'string' ? error.code : 'SMS_DELIVERY_FAILED';
}
function encodeCursor(item: InboxMessage): string {
  return Buffer.from(JSON.stringify([item.createdAt.toISOString(), item.id])).toString('base64url');
}
function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parsed) || parsed.length !== 2 || !utc(parsed[0]) || !uuid(parsed[1]))
      throw new Error();
    return { createdAt: new Date(parsed[0]), id: parsed[1] };
  } catch {
    throw new NotificationError('INVALID_CURSOR');
  }
}
