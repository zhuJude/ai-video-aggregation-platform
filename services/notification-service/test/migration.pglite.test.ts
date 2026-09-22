import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  fileURLToPath(
    new URL('../prisma/migrations/20260914130000_notifications/migration.sql', import.meta.url),
  ),
  'utf8',
);

describe('notification migration', () => {
  it('applies from empty and contains durable idempotency, lease, outbox and operator queue state', async () => {
    const db = new PGlite();
    await db.exec(migration);
    for (const table of [
      'NotificationTemplateVersion',
      'Notification',
      'DeliveryAttempt',
      'InboxMessage',
      'ProcessedEvent',
      'NotificationOutboxEvent',
      'OperatorQueueItem',
    ]) {
      expect(
        (await db.query<{ name: string }>(`SELECT to_regclass('"${table}"')::text AS name`)).rows[0]
          ?.name,
      ).toBe(`"${table}"`);
    }
    await db.exec(
      `INSERT INTO "ProcessedEvent" ("eventId", "eventType", "contractVersion", "occurredAt", "correlationId", "causationId", "processedAt") VALUES ('01990f24-2ba2-7000-8000-000000000001', 'task.succeeded.v1', 1, clock_timestamp(), '01990f24-2ba2-7000-8000-000000000002', '01990f24-2ba2-7000-8000-000000000003', clock_timestamp())`,
    );
    await expect(
      db.exec(
        `INSERT INTO "ProcessedEvent" ("eventId", "eventType", "contractVersion", "occurredAt", "correlationId", "causationId", "processedAt") VALUES ('01990f24-2ba2-7000-8000-000000000001', 'task.succeeded.v1', 1, clock_timestamp(), '01990f24-2ba2-7000-8000-000000000002', '01990f24-2ba2-7000-8000-000000000003', clock_timestamp())`,
      ),
    ).rejects.toThrow();
    expect(migration).toContain('FOR UPDATE SKIP LOCKED');
    expect(migration).toContain('"Notification_eventId_channel_key"');
    expect(migration).toContain('"InboxMessage_notificationId_key"');
    expect(migration).toContain('"phoneKeyVersion"');
    expect(migration).toContain('"phoneWrappedDek"');
    expect(migration).not.toContain('"phoneFingerprint"');
    await db.close();
  }, 30_000);

  it('enforces complete SMS envelope metadata and forbids it for IN_APP rows', async () => {
    const db = new PGlite();
    await db.exec(migration);
    await db.exec(
      `INSERT INTO "NotificationTemplateVersion" ("id", "templateKey", "version", "declaredVariables", "inAppTitle", "inAppBody", "smsBody", "smsSignName", "smsTemplateCode", "publishedAt") VALUES ('01990f24-2ba2-7000-8000-000000000030', 'envelope-test', 1, ARRAY[]::text[], 'title', 'body', 'sms', 'sign', 'SMS_123456', clock_timestamp())`,
    );
    const common = `'01990f24-2ba2-7000-8000-000000000031', '01990f24-2ba2-7000-8000-000000000032', '01990f24-2ba2-7000-8000-000000000033', 'SMS', '01990f24-2ba2-7000-8000-000000000030', 'sms', '{}', decode('0102','hex')`;
    await expect(
      db.exec(
        `INSERT INTO "Notification" ("id", "eventId", "userId", "channel", "templateVersionId", "renderedBody", "variables", "phoneCiphertext", "signName", "templateCode", "nextAttemptAt", "createdAt") VALUES (${common}, 'sign', 'SMS_123456', clock_timestamp(), clock_timestamp())`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `INSERT INTO "Notification" ("id", "eventId", "userId", "channel", "templateVersionId", "renderedBody", "variables", "phoneCiphertext", "phoneKeyVersion", "signName", "templateCode", "nextAttemptAt", "createdAt") VALUES (${common}, 'phone-key-v1', 'sign', 'SMS_123456', clock_timestamp(), clock_timestamp())`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `INSERT INTO "Notification" ("id", "eventId", "userId", "channel", "templateVersionId", "renderedBody", "variables", "phoneCiphertext", "phoneKeyVersion", "phoneWrappedDek", "signName", "templateCode", "nextAttemptAt", "createdAt") VALUES (${common}, 'phone-key-v1', decode('0304','hex'), 'sign', 'SMS_123456', clock_timestamp(), clock_timestamp())`,
    );
    await db.close();
  }, 30_000);

  it('enforces notification channel uniqueness and claims one worker with database CAS', async () => {
    const db = new PGlite();
    await db.exec(migration);
    await db.exec(
      `INSERT INTO "NotificationTemplateVersion" ("id", "templateKey", "version", "declaredVariables", "inAppTitle", "inAppBody", "smsBody", "smsSignName", "smsTemplateCode", "publishedAt") VALUES ('01990f24-2ba2-7000-8000-000000000010', 'task-success', 1, ARRAY['taskId'], 'title', 'body', 'sms', 'sign', 'SMS_123456', clock_timestamp())`,
    );
    const insert = (id: string) =>
      `INSERT INTO "Notification" ("id", "eventId", "userId", "channel", "templateVersionId", "renderedBody", "variables", "phoneCiphertext", "phoneKeyVersion", "phoneWrappedDek", "signName", "templateCode", "nextAttemptAt", "createdAt") VALUES ('${id}', '01990f24-2ba2-7000-8000-000000000011', '01990f24-2ba2-7000-8000-000000000012', 'SMS', '01990f24-2ba2-7000-8000-000000000010', 'sms', '{}', decode('0102','hex'), 'phone-key-v1', decode('0304','hex'), 'sign', 'SMS_123456', clock_timestamp(), clock_timestamp())`;
    await db.exec(insert('01990f24-2ba2-7000-8000-000000000013'));
    await expect(db.exec(insert('01990f24-2ba2-7000-8000-000000000014'))).rejects.toThrow();
    const claims = await Promise.all([
      db.query(
        `SELECT "id" FROM "claim_next_notification"('01990f24-2ba2-7000-8000-000000000015', clock_timestamp() + interval '30 seconds', clock_timestamp())`,
      ),
      db.query(
        `SELECT "id" FROM "claim_next_notification"('01990f24-2ba2-7000-8000-000000000016', clock_timestamp() + interval '30 seconds', clock_timestamp())`,
      ),
    ]);
    expect(claims.map((result) => result.rows.length).sort()).toEqual([0, 1]);
    await db.close();
  }, 30_000);

  it('recovers an unfinished send lease and keeps pending receipts in reconciliation', async () => {
    const db = new PGlite();
    await db.exec(migration);
    await db.exec(
      `INSERT INTO "NotificationTemplateVersion" ("id", "templateKey", "version", "declaredVariables", "inAppTitle", "inAppBody", "smsBody", "smsSignName", "smsTemplateCode", "publishedAt") VALUES ('01990f24-2ba2-7000-8000-000000000020', 'lease-test', 1, ARRAY[]::text[], 'title', 'body', 'sms', 'sign', 'SMS_123456', '2026-09-14T12:00:00.000Z')`,
    );
    await db.exec(
      `INSERT INTO "Notification" ("id", "eventId", "userId", "channel", "templateVersionId", "renderedBody", "variables", "phoneCiphertext", "phoneKeyVersion", "phoneWrappedDek", "signName", "templateCode", "nextAttemptAt", "createdAt") VALUES ('01990f24-2ba2-7000-8000-000000000021', '01990f24-2ba2-7000-8000-000000000022', '01990f24-2ba2-7000-8000-000000000023', 'SMS', '01990f24-2ba2-7000-8000-000000000020', 'sms', '{}', decode('0102','hex'), 'phone-key-v1', decode('0304','hex'), 'sign', 'SMS_123456', '2026-09-14T12:00:00.000Z', '2026-09-14T12:00:00.000Z')`,
    );
    await db.query(
      `SELECT "id" FROM "claim_next_notification"('01990f24-2ba2-7000-8000-000000000024', '2026-09-14T12:00:30.000Z', '2026-09-14T12:00:00.000Z')`,
    );
    expect(
      (
        await db.query<{ sendStartedAt: string; sendDate: string; reconciliationAttempts: number }>(
          `SELECT "sendStartedAt", "sendDate", "reconciliationAttempts" FROM "Notification" WHERE "id" = '01990f24-2ba2-7000-8000-000000000021'`,
        )
      ).rows[0],
    ).toMatchObject({
      sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
      sendDate: '20260914',
      reconciliationAttempts: 0,
    });
    await expect(
      db.exec(
        `UPDATE "Notification" SET "reconciliationAttempts" = -1 WHERE "id" = '01990f24-2ba2-7000-8000-000000000021'`,
      ),
    ).rejects.toThrow();
    await expect(
      db.exec(
        `UPDATE "Notification" SET "sendDate" = NULL WHERE "id" = '01990f24-2ba2-7000-8000-000000000021'`,
      ),
    ).rejects.toThrow();
    await db.exec(
      `INSERT INTO "DeliveryAttempt" ("id", "notificationId", "attemptNumber", "claimToken", "kind", "startedAt") VALUES ('01990f24-2ba2-7000-8000-000000000024', '01990f24-2ba2-7000-8000-000000000021', 1, '01990f24-2ba2-7000-8000-000000000024', 'SEND', '2026-09-14T12:00:00.000Z')`,
    );
    const duringLease = await db.query(
      `SELECT "id" FROM "claim_next_notification"('01990f24-2ba2-7000-8000-000000000025', '2026-09-14T12:01:00.000Z', '2026-09-14T12:00:29.999Z')`,
    );
    const recovered = await db.query(
      `SELECT "id" FROM "claim_next_notification"('01990f24-2ba2-7000-8000-000000000026', '2026-09-14T12:01:00.000Z', '2026-09-14T12:00:30.001Z')`,
    );
    expect(duringLease.rows).toHaveLength(0);
    expect(recovered.rows).toHaveLength(1);
    expect(
      (
        await db.query<{ reconciliationAttempts: number }>(
          `SELECT "reconciliationAttempts" FROM "Notification" WHERE "id" = '01990f24-2ba2-7000-8000-000000000021'`,
        )
      ).rows[0]?.reconciliationAttempts,
    ).toBe(1);
    expect(
      (
        await db.query<{ completedAt: string | null }>(
          `SELECT "completedAt" FROM "DeliveryAttempt" WHERE "notificationId" = '01990f24-2ba2-7000-8000-000000000021'`,
        )
      ).rows[0]?.completedAt,
    ).toBeNull();

    await db.exec(
      `UPDATE "Notification" SET "providerReceiptStatus" = 'PENDING', "providerRequestId" = 'query-1', "providerReceipt" = 'biz-1', "claimToken" = NULL, "leaseUntil" = NULL, "nextAttemptAt" = '2026-09-14T12:02:00.000Z' WHERE "id" = '01990f24-2ba2-7000-8000-000000000021'`,
    );
    const beforeDue = await db.query(
      `SELECT "id" FROM "claim_next_notification"('01990f24-2ba2-7000-8000-000000000027', '2026-09-14T12:03:00.000Z', '2026-09-14T12:01:59.999Z')`,
    );
    const due = await db.query<{ providerReceiptStatus: string }>(
      `SELECT "providerReceiptStatus" FROM "claim_next_notification"('01990f24-2ba2-7000-8000-000000000028', '2026-09-14T12:03:00.000Z', '2026-09-14T12:02:00.000Z')`,
    );
    expect(beforeDue.rows).toHaveLength(0);
    expect(due.rows).toEqual([{ providerReceiptStatus: 'PENDING' }]);
    await db.close();
  }, 30_000);
});
