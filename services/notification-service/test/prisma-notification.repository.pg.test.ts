import { describe, expect, it } from 'vitest';
import { PrismaNotificationRepository } from '../src/adapters/prisma-notification.repository.js';
import { createUuidV7Generator } from '../src/domain/uuid-v7.js';

const url = process.env.NOTIFICATION_TEST_DATABASE_URL;
const connectionString = url ?? '';

describe.skipIf(url === undefined)('notification repository on PostgreSQL', () => {
  it('runs the migration and exposes the database claim function', async () => {
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    try {
      const rows = await prisma.$queryRaw<
        Array<{ functionName: string | null }>
      >`SELECT to_regprocedure('claim_next_notification(uuid,timestamp with time zone,timestamp with time zone)')::text AS "functionName"`;
      expect(rows[0]?.functionName).toContain('claim_next_notification');
    } finally {
      await prisma.$disconnect();
    }
  });

  it('deduplicates concurrent event replay and recovers a crashed lease as reconciliation', async () => {
    const { PrismaPg } = await import('@prisma/adapter-pg');
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
    const repository = new PrismaNotificationRepository(prisma, {
      protect: (phone) =>
        Promise.resolve({
          ciphertext: Buffer.from(phone),
          keyVersion: 'phone-key-v1',
          wrappedKey: Buffer.from('wrapped'),
        }),
      reveal: (protectedPhone) =>
        Promise.resolve(Buffer.from(protectedPhone.ciphertext).toString('utf8')),
    });
    const id = createUuidV7Generator();
    const now = new Date();
    const eventId = id();
    try {
      const template = await repository.publishTemplate({
        id: id(),
        templateKey: `pg-${eventId}`,
        declaredVariables: ['taskId'],
        inAppTitle: 'done',
        inAppBody: '{{taskId}}',
        smsBody: '${taskId}',
        smsSignName: 'sign',
        smsTemplateCode: 'SMS_123456',
        publishedAt: now,
      });
      const input = {
        template,
        eventId,
        eventType: 'task.succeeded.v1',
        userId: id(),
        phoneE164: '+8613800138000',
        variables: { taskId: eventId },
        channels: ['IN_APP', 'SMS'] as const,
        rendered: {
          IN_APP: { title: 'done', body: eventId },
          SMS: { title: null, body: eventId },
        },
        occurredAt: now,
        processedAt: now,
        correlationId: id(),
        causationId: null,
        traceId: 'a'.repeat(32),
        id,
      };
      const accepted = await Promise.all(
        Array.from({ length: 8 }, () => repository.acceptEvent(input)),
      );
      expect(accepted.filter(Boolean)).toHaveLength(1);

      const leaseUntil = new Date(now.getTime() + 30_000);
      const firstClaims = await Promise.all([
        repository.claim(now, id(), leaseUntil),
        repository.claim(now, id(), leaseUntil),
      ]);
      const first = firstClaims.find((claim) => claim !== null);
      expect(firstClaims.filter((claim) => claim !== null)).toHaveLength(1);
      expect(first?.deliveryMode).toBe('SEND');
      expect(first?.sendStartedAt).toEqual(now);
      expect(first?.reconciliationAttempts).toBe(0);

      const recoveredToken = id();
      const recovered = await repository.claim(
        new Date(leaseUntil.getTime() + 1),
        recoveredToken,
        new Date(leaseUntil.getTime() + 30_001),
      );
      expect(recovered).toMatchObject({ id: first?.id, deliveryMode: 'RECONCILE' });
      if (recovered === null) throw new Error('expected recovered notification');
      await repository.reconciliationPending(
        recovered.id,
        recoveredToken,
        { requestId: 'query-1' },
        new Date(leaseUntil.getTime() + 1_001),
        'RECEIPT_PENDING',
        new Date(leaseUntil.getTime() + 1),
      );
      expect(
        await prisma.notification.findUniqueOrThrow({
          where: { id: recovered.id },
          select: { status: true, reconciliationAttempts: true },
        }),
      ).toEqual({ status: 'RECONCILING', reconciliationAttempts: 1 });
    } finally {
      await prisma.deliveryAttempt.deleteMany({ where: { notification: { eventId } } });
      await prisma.inboxMessage.deleteMany({ where: { notification: { eventId } } });
      await prisma.operatorQueueItem.deleteMany({ where: { notification: { eventId } } });
      await prisma.notificationOutboxEvent.deleteMany({ where: { causationId: eventId } });
      await prisma.notification.deleteMany({ where: { eventId } });
      await prisma.processedEvent.deleteMany({ where: { eventId } });
      await prisma.$disconnect();
    }
  });
});
