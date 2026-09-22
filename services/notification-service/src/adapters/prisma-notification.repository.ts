import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { Prisma, PrismaClient } from '../../generated/prisma/index.js';
import type {
  InboxMessage,
  NotificationRecord,
  NotificationRepository,
  TemplateVersion,
} from '../application/notification.consumer.js';
import { NotificationError } from '../application/notification.consumer.js';
import { UUID_V7_PATTERN } from '../domain/uuid-v7.js';

export interface KmsDataKeyResolver {
  generateDataKey(reference: string): Promise<{
    plaintextKey: Buffer;
    wrappedKey: Buffer;
    keyVersion: string;
  }>;
  decryptDataKey(input: { wrappedKey: Uint8Array; keyVersion: string }): Promise<Buffer>;
}
export interface ProtectedPhone {
  ciphertext: Buffer;
  wrappedKey: Buffer;
  keyVersion: string;
}
export interface PhoneProtector {
  protect(phone: string): Promise<ProtectedPhone>;
  reveal(input: {
    ciphertext: Uint8Array;
    wrappedKey: Uint8Array;
    keyVersion: string;
  }): Promise<string>;
}

export class KmsPhoneProtector implements PhoneProtector {
  constructor(
    private readonly kmsReference: string,
    private readonly kms: KmsDataKeyResolver,
    private readonly nonce: () => Buffer = () => randomBytes(12),
  ) {
    if (!/^kms:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$/.test(kmsReference))
      throw new Error('KMS_REFERENCE_REQUIRED');
  }
  async protect(phone: string): Promise<ProtectedPhone> {
    const dataKey = await this.kms.generateDataKey(this.kmsReference);
    const key = validateDataKey(dataKey.plaintextKey);
    if (
      dataKey.wrappedKey.length === 0 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(dataKey.keyVersion)
    )
      throw new Error('INVALID_KMS_DATA_KEY_ENVELOPE');
    const iv = this.nonce();
    if (iv.length !== 12) throw new Error('INVALID_ENCRYPTION_NONCE');
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(phone, 'utf8'), cipher.final()]);
    return {
      ciphertext: Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
      wrappedKey: Buffer.from(dataKey.wrappedKey),
      keyVersion: dataKey.keyVersion,
    };
  }
  async reveal(input: {
    ciphertext: Uint8Array;
    wrappedKey: Uint8Array;
    keyVersion: string;
  }): Promise<string> {
    const buffer = Buffer.from(input.ciphertext);
    if (buffer.length < 29) throw new Error('INVALID_PHONE_CIPHERTEXT');
    const key = validateDataKey(
      await this.kms.decryptDataKey({
        wrappedKey: input.wrappedKey,
        keyVersion: input.keyVersion,
      }),
    );
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
  }
}

function validateDataKey(key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('INVALID_KMS_DATA_KEY');
  return key;
}

type PrismaTx = Prisma.TransactionClient;
export type PrismaNotificationClient = PrismaClient;

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(
    private readonly prisma: PrismaNotificationClient,
    private readonly phones: PhoneProtector,
  ) {}
  publishTemplate(input: Omit<TemplateVersion, 'version'>): Promise<TemplateVersion> {
    return this.prisma.$transaction(async (tx) => {
      const latest = asTemplate(
        await tx.notificationTemplateVersion.findFirst({
          where: { templateKey: input.templateKey },
          orderBy: { version: 'desc' },
        }),
      );
      const created = asTemplate(
        await tx.notificationTemplateVersion.create({
          data: {
            ...input,
            declaredVariables: [...input.declaredVariables],
            version: (latest?.version ?? 0) + 1,
          },
        }),
      );
      if (created === null) throw new Error('TEMPLATE_CREATE_FAILED');
      return created;
    });
  }
  async latestTemplate(key: string): Promise<TemplateVersion | null> {
    return asTemplate(
      await this.prisma.notificationTemplateVersion.findFirst({
        where: { templateKey: key },
        orderBy: { version: 'desc' },
      }),
    );
  }
  async hasProcessedEvent(eventId: string): Promise<boolean> {
    return (await this.prisma.processedEvent.count({ where: { eventId } })) !== 0;
  }
  async acceptEvent(input: Parameters<NotificationRepository['acceptEvent']>[0]): Promise<boolean> {
    try {
      const protectedPhone =
        input.phoneE164 === null || !input.channels.includes('SMS')
          ? null
          : await this.phones.protect(input.phoneE164);
      await this.prisma.$transaction(async (tx) => {
        await tx.processedEvent.create({
          data: {
            eventId: input.eventId,
            eventType: input.eventType,
            contractVersion: 1,
            occurredAt: input.occurredAt,
            correlationId: input.correlationId,
            causationId: input.causationId,
            processedAt: input.processedAt,
          },
        });
        for (const channel of new Set(input.channels)) {
          const rendered = input.rendered[channel];
          const notificationId = input.id();
          await tx.notification.create({
            data: {
              id: notificationId,
              eventId: input.eventId,
              userId: input.userId,
              channel,
              templateVersionId: input.template.id,
              renderedTitle: rendered.title,
              renderedBody: rendered.body,
              variables: structuredClone(input.variables),
              ...(channel === 'SMS' && protectedPhone !== null
                ? {
                    phoneCiphertext: new Uint8Array(protectedPhone.ciphertext),
                    phoneKeyVersion: protectedPhone.keyVersion,
                    phoneWrappedDek: new Uint8Array(protectedPhone.wrappedKey),
                    signName: input.template.smsSignName,
                    templateCode: input.template.smsTemplateCode,
                  }
                : {}),
              status: channel === 'SMS' ? 'PENDING' : 'DELIVERED',
              attempts: 0,
              nextAttemptAt: input.occurredAt,
              createdAt: input.occurredAt,
            },
          });
          if (channel === 'IN_APP')
            await tx.inboxMessage.create({
              data: {
                id: input.id(),
                notificationId,
                userId: input.userId,
                title: rendered.title ?? '',
                body: rendered.body,
                createdAt: input.occurredAt,
              },
            });
          await tx.notificationOutboxEvent.create({
            data: {
              id: input.id(),
              eventType: 'notification.created.v1',
              contractVersion: 1,
              occurredAt: input.occurredAt,
              traceId: input.traceId,
              correlationId: input.correlationId,
              causationId: input.eventId,
              payload: { notification_id: notificationId, channel },
              status: 'PENDING',
              nextAttemptAt: input.occurredAt,
              createdAt: input.occurredAt,
            },
          });
        }
      });
      return true;
    } catch (error) {
      if (isUniqueConflict(error)) return false;
      throw error;
    }
  }
  claim(now: Date, claimToken: string, leaseUntil: Date): Promise<NotificationRecord | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<PrismaNotificationRow[]>(
        'SELECT * FROM "claim_next_notification"($1::uuid, $2::timestamptz, $3::timestamptz)',
        claimToken,
        leaseUntil,
        now,
      );
      const row = rows[0];
      if (row === undefined) return null;
      const unfinished = await tx.deliveryAttempt.findFirst({
        where: { notificationId: row.id, completedAt: null },
        orderBy: { attemptNumber: 'desc' },
      });
      const deliveryMode =
        unfinished === null && row.providerReceiptStatus === null ? 'SEND' : 'RECONCILE';
      if (unfinished === null) {
        const latestAttempt = await tx.deliveryAttempt.findFirst({
          where: { notificationId: row.id },
          orderBy: { attemptNumber: 'desc' },
          select: { attemptNumber: true },
        });
        await tx.deliveryAttempt.create({
          data: {
            id: claimToken,
            notificationId: row.id,
            attemptNumber: (latestAttempt?.attemptNumber ?? 0) + 1,
            claimToken,
            kind: deliveryMode,
            startedAt: now,
          },
        });
      } else
        await tx.deliveryAttempt.updateMany({
          where: { notificationId: row.id, completedAt: null },
          data: { claimToken, kind: deliveryMode, startedAt: now },
        });
      try {
        return { ...(await this.toRecord(row)), deliveryMode };
      } catch {
        await assertCas(
          tx.notification.updateMany({
            where: { id: row.id, claimToken, status: 'RECONCILING' },
            data: {
              status: 'OPERATOR_REVIEW',
              lastErrorCode: 'PHONE_DECRYPTION_FAILED',
              claimToken: null,
              leaseUntil: null,
            },
          }),
        );
        await tx.deliveryAttempt.updateMany({
          where: { claimToken },
          data: { errorCode: 'PHONE_DECRYPTION_FAILED', completedAt: now },
        });
        await tx.operatorQueueItem.upsert({
          where: {
            notificationId_reasonCode: {
              notificationId: row.id,
              reasonCode: 'PHONE_DECRYPTION_FAILED',
            },
          },
          create: {
            id: claimToken,
            notificationId: row.id,
            reasonCode: 'PHONE_DECRYPTION_FAILED',
            createdAt: now,
          },
          update: {},
        });
        return null;
      }
    });
  }
  accepted(
    id: string,
    claimToken: string,
    result: { requestId: string; receipt: string },
    nextAttemptAt: Date,
    now: Date,
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await assertCas(
        tx.notification.updateMany({
          where: { id, claimToken, status: 'RECONCILING' },
          data: {
            providerRequestId: result.requestId,
            providerReceipt: result.receipt,
            providerReceiptStatus: 'ACCEPTED',
            nextAttemptAt,
            claimToken: null,
            leaseUntil: null,
          },
        }),
      );
      await tx.deliveryAttempt.updateMany({
        where: { claimToken },
        data: {
          providerRequestId: result.requestId,
          providerReceipt: result.receipt,
          providerReceiptStatus: 'ACCEPTED',
          completedAt: now,
        },
      });
    });
  }
  unknownAcceptance(
    id: string,
    claimToken: string,
    nextAttemptAt: Date,
    code: string,
    now: Date,
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await assertCas(
        tx.notification.updateMany({
          where: { id, claimToken, status: 'RECONCILING' },
          data: {
            providerReceiptStatus: 'UNKNOWN_ACCEPTANCE',
            nextAttemptAt,
            lastErrorCode: code,
            claimToken: null,
            leaseUntil: null,
          },
        }),
      );
      await tx.deliveryAttempt.updateMany({
        where: { claimToken },
        data: {
          providerReceiptStatus: 'UNKNOWN_ACCEPTANCE',
          errorCode: code,
          completedAt: now,
        },
      });
    });
  }
  reconciliationPending(
    id: string,
    claimToken: string,
    result: { requestId?: string; receipt?: string },
    nextAttemptAt: Date,
    code: string,
    now: Date,
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await assertCas(
        tx.notification.updateMany({
          where: { id, claimToken, status: 'RECONCILING' },
          data: {
            providerReceiptStatus: 'PENDING',
            ...(result.requestId === undefined ? {} : { providerRequestId: result.requestId }),
            ...(result.receipt === undefined ? {} : { providerReceipt: result.receipt }),
            nextAttemptAt,
            lastErrorCode: code,
            claimToken: null,
            leaseUntil: null,
          },
        }),
      );
      await tx.deliveryAttempt.updateMany({
        where: { claimToken },
        data: {
          providerReceiptStatus: 'PENDING',
          ...(result.requestId === undefined ? {} : { providerRequestId: result.requestId }),
          ...(result.receipt === undefined ? {} : { providerReceipt: result.receipt }),
          errorCode: code,
          completedAt: now,
        },
      });
    });
  }
  complete(
    id: string,
    claimToken: string,
    result: { requestId: string; receipt?: string },
    now: Date,
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await assertCas(
        tx.notification.updateMany({
          where: { id, claimToken, status: 'RECONCILING' },
          data: {
            status: 'DELIVERED',
            providerRequestId: result.requestId,
            ...(result.receipt === undefined ? {} : { providerReceipt: result.receipt }),
            providerReceiptStatus: 'DELIVERED',
            deliveredAt: now,
            claimToken: null,
            leaseUntil: null,
          },
        }),
      );
      await tx.deliveryAttempt.updateMany({
        where: { claimToken },
        data: {
          providerRequestId: result.requestId,
          ...(result.receipt === undefined ? {} : { providerReceipt: result.receipt }),
          providerReceiptStatus: 'DELIVERED',
          completedAt: now,
        },
      });
    });
  }
  confirmNotAccepted(
    id: string,
    claimToken: string,
    result: { requestId: string; receipt?: string },
    nextAttemptAt: Date,
    now: Date,
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await assertCas(
        tx.notification.updateMany({
          where: { id, claimToken, status: 'RECONCILING' },
          data: {
            status: 'RETRY_PENDING',
            providerRequestId: null,
            providerReceipt: null,
            providerReceiptStatus: null,
            nextAttemptAt,
            claimToken: null,
            leaseUntil: null,
          },
        }),
      );
      await tx.deliveryAttempt.updateMany({
        where: { claimToken },
        data: {
          providerRequestId: result.requestId,
          ...(result.receipt === undefined ? {} : { providerReceipt: result.receipt }),
          providerReceiptStatus: 'NOT_ACCEPTED',
          errorCode: 'PROVIDER_CONFIRMED_NOT_ACCEPTED',
          completedAt: now,
        },
      });
    });
  }
  retry(
    id: string,
    claimToken: string,
    nextAttemptAt: Date,
    code: string,
    now: Date,
  ): Promise<void> {
    return this.transaction(async (tx) => {
      await assertCas(
        tx.notification.updateMany({
          where: { id, claimToken, status: 'RECONCILING' },
          data: {
            status: 'RETRY_PENDING',
            nextAttemptAt,
            lastErrorCode: code,
            claimToken: null,
            leaseUntil: null,
          },
        }),
      );
      await tx.deliveryAttempt.updateMany({
        where: { claimToken },
        data: { errorCode: code, completedAt: now },
      });
    });
  }
  operatorReview(id: string, claimToken: string, code: string, now: Date): Promise<void> {
    return this.transaction(async (tx) => {
      await assertCas(
        tx.notification.updateMany({
          where: { id, claimToken, status: 'RECONCILING' },
          data: {
            status: 'OPERATOR_REVIEW',
            lastErrorCode: code,
            claimToken: null,
            leaseUntil: null,
          },
        }),
      );
      await tx.deliveryAttempt.updateMany({
        where: { claimToken },
        data: { errorCode: code, completedAt: now },
      });
      await tx.operatorQueueItem.upsert({
        where: { notificationId_reasonCode: { notificationId: id, reasonCode: code } },
        create: { id: claimToken, notificationId: id, reasonCode: code, createdAt: now },
        update: {},
      });
    });
  }
  async listInbox(
    userId: string,
    input: { limit: number; cursor?: string },
  ): Promise<{ items: InboxMessage[]; nextCursor?: string }> {
    const cursor = input.cursor === undefined ? null : parseInboxCursor(input.cursor);
    const rows = await this.prisma.inboxMessage.findMany({
      where: {
        userId,
        ...(cursor === null
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    });
    const items = rows.slice(0, input.limit).map(asInbox);
    const last = items.at(-1);
    return {
      items,
      ...(rows.length > input.limit && last !== undefined
        ? {
            nextCursor: Buffer.from(
              JSON.stringify([last.createdAt.toISOString(), last.id]),
            ).toString('base64url'),
          }
        : {}),
    };
  }
  async markRead(userId: string, messageId: string, now: Date): Promise<InboxMessage | null> {
    await this.prisma.inboxMessage.updateMany({
      where: { id: messageId, userId, readAt: null },
      data: { readAt: now },
    });
    const updated = await this.prisma.inboxMessage.findFirst({ where: { id: messageId, userId } });
    return updated === null ? null : asInbox(updated);
  }
  private transaction(action: (tx: PrismaTx) => Promise<void>): Promise<void> {
    return this.prisma.$transaction(action);
  }
  private async toRecord(row: PrismaNotificationRow): Promise<NotificationRecord> {
    return {
      id: row.id,
      eventId: row.eventId,
      userId: row.userId,
      channel: row.channel,
      templateVersionId: row.templateVersionId,
      renderedTitle: row.renderedTitle,
      renderedBody: row.renderedBody,
      variables: row.variables,
      phoneE164:
        row.phoneCiphertext === null || row.phoneWrappedDek === null || row.phoneKeyVersion === null
          ? null
          : await this.phones.reveal({
              ciphertext: row.phoneCiphertext,
              wrappedKey: row.phoneWrappedDek,
              keyVersion: row.phoneKeyVersion,
            }),
      signName: row.signName,
      templateCode: row.templateCode,
      status: row.status,
      attempts: row.attempts,
      nextAttemptAt: row.nextAttemptAt,
      claimToken: row.claimToken,
      leaseUntil: row.leaseUntil,
      providerRequestId: row.providerRequestId,
      providerReceipt: row.providerReceipt,
      providerReceiptStatus: row.providerReceiptStatus,
      reconciliationAttempts: row.reconciliationAttempts,
      sendStartedAt: row.sendStartedAt,
      sendDate: row.sendDate,
      createdAt: row.createdAt,
    };
  }
}

interface PrismaNotificationRow extends NotificationRecord {
  phoneCiphertext: Uint8Array | null;
  phoneWrappedDek: Uint8Array | null;
  phoneKeyVersion: string | null;
}
function asTemplate(value: unknown): TemplateVersion | null {
  return value === null ? null : (value as TemplateVersion);
}
function asInbox(value: unknown): InboxMessage {
  return value as InboxMessage;
}
function isUniqueConflict(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
async function assertCas(result: Promise<{ count: number }>): Promise<void> {
  if ((await result).count !== 1) throw new NotificationError('LEASE_LOST', true);
}
export function parseInboxCursor(value: string): { createdAt: Date; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (
      !Array.isArray(parsed) ||
      parsed.length !== 2 ||
      typeof parsed[0] !== 'string' ||
      typeof parsed[1] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(parsed[0]) ||
      !UUID_V7_PATTERN.test(parsed[1])
    )
      throw new Error();
    const createdAt = new Date(parsed[0]);
    if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== parsed[0])
      throw new Error();
    return { createdAt, id: parsed[1] };
  } catch {
    throw new NotificationError('INVALID_CURSOR');
  }
}
