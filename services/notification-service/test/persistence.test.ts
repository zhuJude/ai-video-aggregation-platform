/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await -- deliberately minimal Prisma/KMS test doubles exercise transaction payloads. */
import { describe, expect, it, vi } from 'vitest';
import {
  KmsPhoneProtector,
  PrismaNotificationRepository,
  parseInboxCursor,
} from '../src/adapters/prisma-notification.repository.js';

const KEY = Buffer.alloc(32, 7);
const SECOND_KEY = Buffer.alloc(32, 8);
const WRAPPED_KEY = Buffer.from('wrapped-data-key-v1');
const SECOND_WRAPPED_KEY = Buffer.from('wrapped-data-key-v2');

describe('Prisma notification persistence', () => {
  it('strictly validates canonical cursor timestamps and UUIDv7 ids', () => {
    const valid = Buffer.from(
      JSON.stringify(['2026-09-14T12:00:00.000Z', '01990f24-2ba2-7000-8000-000000000001']),
    ).toString('base64url');
    expect(parseInboxCursor(valid)).toEqual({
      createdAt: new Date('2026-09-14T12:00:00.000Z'),
      id: '01990f24-2ba2-7000-8000-000000000001',
    });
    for (const tuple of [
      ['2026-09-14 12:00:00', '01990f24-2ba2-7000-8000-000000000001'],
      ['2026-09-14T12:00:00.000Z', '550e8400-e29b-41d4-a716-446655440000'],
    ]) {
      const malformed = Buffer.from(JSON.stringify(tuple)).toString('base64url');
      expect(() => parseInboxCursor(malformed)).toThrow(
        expect.objectContaining({ code: 'INVALID_CURSOR' }),
      );
    }
    expect(() => parseInboxCursor('not-base64-json')).toThrow(
      expect.objectContaining({ code: 'INVALID_CURSOR' }),
    );
  });
  it('envelope-encrypts phones and decrypts historical rows after the primary KMS ref rotates', async () => {
    const kms = {
      generateDataKey: vi
        .fn()
        .mockResolvedValueOnce({
          plaintextKey: KEY,
          wrappedKey: WRAPPED_KEY,
          keyVersion: 'phone-key-v1',
        })
        .mockResolvedValueOnce({
          plaintextKey: SECOND_KEY,
          wrappedKey: SECOND_WRAPPED_KEY,
          keyVersion: 'phone-key-v1',
        }),
      decryptDataKey: vi
        .fn()
        .mockImplementation(async (input: { wrappedKey: Uint8Array; keyVersion: string }) => {
          expect(input.keyVersion).toBe('phone-key-v1');
          return Buffer.from(input.wrappedKey).equals(WRAPPED_KEY) ? KEY : SECOND_KEY;
        }),
    };
    const protector = new KmsPhoneProtector('kms://prod/notification/phone-key', kms, () =>
      Buffer.alloc(12, 3),
    );
    const first = await protector.protect('+8613800138000');
    const second = await protector.protect('+8613800138000');
    expect(first.ciphertext.toString('utf8')).not.toContain('13800138000');
    expect(first.ciphertext).not.toEqual(second.ciphertext);
    expect(first).not.toHaveProperty('fingerprint');
    expect(second).not.toHaveProperty('fingerprint');
    expect(first).toMatchObject({ keyVersion: 'phone-key-v1', wrappedKey: WRAPPED_KEY });
    const rotatedProtector = new KmsPhoneProtector(
      'kms://prod/notification/phone-key-v2',
      kms,
      () => Buffer.alloc(12, 4),
    );
    expect(await rotatedProtector.reveal(first)).toBe('+8613800138000');
    expect(kms.generateDataKey).toHaveBeenCalledWith('kms://prod/notification/phone-key');
    expect(kms.decryptDataKey).toHaveBeenCalledTimes(1);
  });

  it('does not invoke phone protection for an IN_APP-only event and records processing clock', async () => {
    const protect = vi.fn();
    const processedEventCreate = vi.fn().mockResolvedValue({});
    const tx = {
      processedEvent: { create: processedEventCreate },
      notification: { create: vi.fn().mockResolvedValue({}) },
      inboxMessage: { create: vi.fn().mockResolvedValue({}) },
      notificationOutboxEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: vi.fn(async (action: (value: typeof tx) => unknown) => action(tx)),
    };
    const repository = new PrismaNotificationRepository(
      prisma as never,
      {
        protect,
        reveal: vi.fn(),
      } as never,
    );
    const processedAt = new Date('2026-09-14T13:15:00.000Z');
    await repository.acceptEvent({
      eventId: '01990f24-2ba2-7000-8000-000000000001',
      eventType: 'task.succeeded.v1',
      userId: '01990f24-2ba2-7000-8000-000000000002',
      phoneE164: '+8613800138000',
      variables: {},
      channels: ['IN_APP'],
      rendered: { IN_APP: { title: 'title', body: 'body' }, SMS: { title: null, body: 'sms' } },
      occurredAt: new Date('2026-09-14T12:00:00.000Z'),
      processedAt,
      correlationId: '01990f24-2ba2-7000-8000-000000000003',
      causationId: null,
      traceId: 'a'.repeat(32),
      template: {
        id: '01990f24-2ba2-7000-8000-000000000004',
        templateKey: 'task-success',
        version: 1,
        declaredVariables: [],
        inAppTitle: 'title',
        inAppBody: 'body',
        smsBody: 'sms',
        smsSignName: 'sign',
        smsTemplateCode: 'SMS_123456',
        publishedAt: processedAt,
      },
      id: (() => {
        let sequence = 10;
        return () => `01990f24-2ba2-7000-8000-${String(++sequence).padStart(12, '0')}`;
      })(),
    } as never);
    expect(protect).not.toHaveBeenCalled();
    expect(processedEventCreate).toHaveBeenCalledWith({
      data: expect.objectContaining({ processedAt }),
    });
  });

  it('uses the actual completion clock rather than nextAttemptAt for failed delivery audits', async () => {
    const deliveryUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const tx = {
      notification: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      deliveryAttempt: { updateMany: deliveryUpdate },
    };
    const prisma = {
      $transaction: vi.fn(async (action: (value: typeof tx) => unknown) => action(tx)),
    };
    const repository = new PrismaNotificationRepository(prisma as never, {} as never);
    const retryAt = new Date('2026-09-14T13:30:00.000Z');
    const completedAt = new Date('2026-09-14T13:00:00.000Z');
    await repository.retry(
      '01990f24-2ba2-7000-8000-000000000001',
      '01990f24-2ba2-7000-8000-000000000002',
      retryAt,
      'TRANSIENT',
      completedAt,
    );
    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ completedAt }) }),
    );
  });

  it('terminates an undecryptable claimed SMS in the operator queue without rolling back', async () => {
    const now = new Date('2026-09-14T13:00:00.000Z');
    const notificationUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const deliveryUpdate = vi.fn().mockResolvedValue({ count: 1 });
    const operatorUpsert = vi.fn().mockResolvedValue({});
    const tx = {
      $queryRawUnsafe: vi.fn().mockResolvedValue([
        {
          id: '01990f24-2ba2-7000-8000-000000000001',
          eventId: '01990f24-2ba2-7000-8000-000000000002',
          userId: '01990f24-2ba2-7000-8000-000000000003',
          channel: 'SMS',
          templateVersionId: '01990f24-2ba2-7000-8000-000000000004',
          renderedTitle: null,
          renderedBody: 'sms',
          variables: {},
          phoneCiphertext: new Uint8Array([1, 2]),
          phoneKeyVersion: 'phone-key-v1',
          phoneWrappedDek: new Uint8Array([3, 4]),
          signName: 'sign',
          templateCode: 'SMS_123456',
          status: 'RECONCILING',
          attempts: 1,
          nextAttemptAt: now,
          claimToken: '01990f24-2ba2-7000-8000-000000000005',
          leaseUntil: new Date(now.getTime() + 30_000),
          providerRequestId: null,
          providerReceipt: null,
          providerReceiptStatus: null,
          reconciliationAttempts: 0,
          sendStartedAt: now,
          sendDate: '20260914',
          createdAt: now,
        },
      ]),
      deliveryAttempt: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
        updateMany: deliveryUpdate,
      },
      notification: { updateMany: notificationUpdate },
      operatorQueueItem: { upsert: operatorUpsert },
    };
    const prisma = {
      $transaction: vi.fn(async (action: (value: typeof tx) => unknown) => action(tx)),
    };
    const repository = new PrismaNotificationRepository(
      prisma as never,
      {
        protect: vi.fn(),
        reveal: vi.fn().mockRejectedValue(new Error('kms secret must not leak')),
      } as never,
    );
    await expect(
      repository.claim(
        now,
        '01990f24-2ba2-7000-8000-000000000005',
        new Date(now.getTime() + 30_000),
      ),
    ).resolves.toBeNull();
    expect(notificationUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'OPERATOR_REVIEW',
          lastErrorCode: 'PHONE_DECRYPTION_FAILED',
        }),
      }),
    );
    expect(deliveryUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ completedAt: now }) }),
    );
    expect(operatorUpsert).toHaveBeenCalled();
    expect(JSON.stringify(notificationUpdate.mock.calls)).not.toContain('kms secret must not leak');
  });

  it('uses one database transaction and treats event unique conflicts as replay', async () => {
    const duplicate = Object.assign(new Error('unique'), { code: 'P2002' });
    const prisma = { $transaction: vi.fn().mockRejectedValue(duplicate) };
    const repository = new PrismaNotificationRepository(prisma as never, {
      protect: vi.fn(),
      reveal: vi.fn(),
    });
    const accepted = await repository.acceptEvent({
      eventId: '01990f24-2ba2-7000-8000-000000000001',
      phoneE164: null,
      channels: [],
    } as never);
    expect(accepted).toBe(false);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
