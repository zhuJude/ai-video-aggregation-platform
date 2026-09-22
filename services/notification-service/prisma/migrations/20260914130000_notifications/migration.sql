CREATE TYPE "NotificationChannel" AS ENUM ('IN_APP', 'SMS');
CREATE TYPE "NotificationStatus" AS ENUM ('PENDING', 'RECONCILING', 'RETRY_PENDING', 'DELIVERED', 'OPERATOR_REVIEW');
CREATE TYPE "ProviderReceiptStatus" AS ENUM ('ACCEPTED', 'UNKNOWN_ACCEPTANCE', 'PENDING', 'DELIVERED', 'FAILED', 'NOT_ACCEPTED');
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'CLAIMED', 'PUBLISHED', 'FAILED');
CREATE TYPE "OperatorQueueStatus" AS ENUM ('OPEN', 'RESOLVED');

CREATE FUNCTION "notification_uuid_is_v7"(value uuid) RETURNS boolean
LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT substring(value::text from 15 for 1) = '7'
     AND substring(value::text from 20 for 1) ~ '^[89ab]$'
$$;

CREATE TABLE "NotificationTemplateVersion" (
  "id" uuid PRIMARY KEY,
  "templateKey" varchar(128) NOT NULL,
  "version" integer NOT NULL,
  "declaredVariables" text[] NOT NULL,
  "inAppTitle" varchar(200) NOT NULL,
  "inAppBody" text NOT NULL,
  "smsBody" varchar(1000) NOT NULL,
  "smsSignName" varchar(100) NOT NULL,
  "smsTemplateCode" varchar(64) NOT NULL,
  "publishedAt" timestamptz(3) NOT NULL,
  CONSTRAINT "NotificationTemplateVersion_id_v7" CHECK ("notification_uuid_is_v7"("id")),
  CONSTRAINT "NotificationTemplateVersion_version_check" CHECK ("version" > 0),
  CONSTRAINT "NotificationTemplateVersion_key_check" CHECK ("templateKey" ~ '^[a-z0-9][a-z0-9-]{1,127}$'),
  CONSTRAINT "NotificationTemplateVersion_code_check" CHECK ("smsTemplateCode" ~ '^SMS_[0-9]{6,20}$'),
  CONSTRAINT "NotificationTemplateVersion_templateKey_version_key" UNIQUE ("templateKey", "version")
);
CREATE INDEX "NotificationTemplateVersion_templateKey_publishedAt_idx" ON "NotificationTemplateVersion" ("templateKey", "publishedAt" DESC);

CREATE TABLE "ProcessedEvent" (
  "eventId" uuid PRIMARY KEY,
  "eventType" varchar(160) NOT NULL,
  "contractVersion" integer NOT NULL,
  "occurredAt" timestamptz(3) NOT NULL,
  "correlationId" uuid NOT NULL,
  "causationId" uuid,
  "processedAt" timestamptz(3) NOT NULL,
  CONSTRAINT "ProcessedEvent_event_v7" CHECK ("notification_uuid_is_v7"("eventId")),
  CONSTRAINT "ProcessedEvent_correlation_v7" CHECK ("notification_uuid_is_v7"("correlationId")),
  CONSTRAINT "ProcessedEvent_causation_v7" CHECK ("causationId" IS NULL OR "notification_uuid_is_v7"("causationId")),
  CONSTRAINT "ProcessedEvent_contract_check" CHECK ("contractVersion" = 1)
);

CREATE TABLE "Notification" (
  "id" uuid PRIMARY KEY,
  "eventId" uuid NOT NULL,
  "userId" uuid NOT NULL,
  "channel" "NotificationChannel" NOT NULL,
  "templateVersionId" uuid NOT NULL REFERENCES "NotificationTemplateVersion"("id") ON DELETE RESTRICT,
  "renderedTitle" varchar(200), "renderedBody" text NOT NULL, "variables" jsonb NOT NULL,
  "phoneCiphertext" bytea, "phoneKeyVersion" varchar(128), "phoneWrappedDek" bytea, "signName" varchar(100), "templateCode" varchar(64),
  "status" "NotificationStatus" NOT NULL DEFAULT 'PENDING', "attempts" integer NOT NULL DEFAULT 0,
  "nextAttemptAt" timestamptz(3) NOT NULL, "claimToken" uuid, "leaseUntil" timestamptz(3),
  "providerRequestId" varchar(128), "providerReceipt" varchar(256), "providerReceiptStatus" "ProviderReceiptStatus",
  "reconciliationAttempts" integer NOT NULL DEFAULT 0, "sendStartedAt" timestamptz(3), "sendDate" char(8), "lastErrorCode" varchar(128),
  "createdAt" timestamptz(3) NOT NULL, "deliveredAt" timestamptz(3),
  CONSTRAINT "Notification_id_v7" CHECK ("notification_uuid_is_v7"("id")),
  CONSTRAINT "Notification_event_v7" CHECK ("notification_uuid_is_v7"("eventId")),
  CONSTRAINT "Notification_user_v7" CHECK ("notification_uuid_is_v7"("userId")),
  CONSTRAINT "Notification_claim_v7" CHECK ("claimToken" IS NULL OR "notification_uuid_is_v7"("claimToken")),
  CONSTRAINT "Notification_attempts_check" CHECK ("attempts" >= 0),
  CONSTRAINT "Notification_reconciliation_attempts_check" CHECK ("reconciliationAttempts" >= 0),
  CONSTRAINT "Notification_send_started_check" CHECK ("sendStartedAt" IS NULL OR "channel" = 'SMS'),
  CONSTRAINT "Notification_send_date_check" CHECK ("sendDate" IS NULL OR ("channel" = 'SMS' AND "sendDate" ~ '^[0-9]{8}$')),
  CONSTRAINT "Notification_send_time_pair_check" CHECK (("sendStartedAt" IS NULL) = ("sendDate" IS NULL)),
  CONSTRAINT "Notification_phone_key_version_check" CHECK ("phoneKeyVersion" IS NULL OR "phoneKeyVersion" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'),
  CONSTRAINT "Notification_channel_fields_check" CHECK (("channel" = 'IN_APP' AND "phoneCiphertext" IS NULL AND "phoneKeyVersion" IS NULL AND "phoneWrappedDek" IS NULL AND "signName" IS NULL AND "templateCode" IS NULL) OR ("channel" = 'SMS' AND "phoneCiphertext" IS NOT NULL AND "phoneKeyVersion" IS NOT NULL AND "phoneWrappedDek" IS NOT NULL AND octet_length("phoneWrappedDek") > 0 AND "signName" IS NOT NULL AND "templateCode" IS NOT NULL)),
  CONSTRAINT "Notification_eventId_channel_key" UNIQUE ("eventId", "channel")
);
CREATE INDEX "Notification_delivery_idx" ON "Notification" ("status", "nextAttemptAt", "leaseUntil");
CREATE INDEX "Notification_user_cursor_idx" ON "Notification" ("userId", "createdAt" DESC, "id" DESC);

CREATE TABLE "DeliveryAttempt" (
  "id" uuid PRIMARY KEY, "notificationId" uuid NOT NULL REFERENCES "Notification"("id") ON DELETE RESTRICT,
  "attemptNumber" integer NOT NULL, "claimToken" uuid NOT NULL, "kind" varchar(32) NOT NULL,
  "providerRequestId" varchar(128), "providerReceipt" varchar(256), "providerReceiptStatus" "ProviderReceiptStatus", "errorCode" varchar(128),
  "startedAt" timestamptz(3) NOT NULL, "completedAt" timestamptz(3),
  CONSTRAINT "DeliveryAttempt_id_v7" CHECK ("notification_uuid_is_v7"("id")),
  CONSTRAINT "DeliveryAttempt_claim_v7" CHECK ("notification_uuid_is_v7"("claimToken")),
  CONSTRAINT "DeliveryAttempt_number_check" CHECK ("attemptNumber" > 0),
  CONSTRAINT "DeliveryAttempt_notificationId_attemptNumber_key" UNIQUE ("notificationId", "attemptNumber"),
  CONSTRAINT "DeliveryAttempt_claimToken_key" UNIQUE ("claimToken")
);
CREATE INDEX "DeliveryAttempt_notification_started_idx" ON "DeliveryAttempt" ("notificationId", "startedAt" DESC);

CREATE TABLE "InboxMessage" (
  "id" uuid PRIMARY KEY, "notificationId" uuid NOT NULL REFERENCES "Notification"("id") ON DELETE RESTRICT,
  "userId" uuid NOT NULL, "title" varchar(200) NOT NULL, "body" text NOT NULL,
  "readAt" timestamptz(3), "createdAt" timestamptz(3) NOT NULL,
  CONSTRAINT "InboxMessage_id_v7" CHECK ("notification_uuid_is_v7"("id")),
  CONSTRAINT "InboxMessage_user_v7" CHECK ("notification_uuid_is_v7"("userId")),
  CONSTRAINT "InboxMessage_notificationId_key" UNIQUE ("notificationId")
);
CREATE INDEX "InboxMessage_user_cursor_idx" ON "InboxMessage" ("userId", "createdAt" DESC, "id" DESC);

CREATE TABLE "NotificationOutboxEvent" (
  "id" uuid PRIMARY KEY, "eventType" varchar(160) NOT NULL, "contractVersion" integer NOT NULL,
  "occurredAt" timestamptz(3) NOT NULL, "traceId" char(32) NOT NULL, "correlationId" uuid NOT NULL, "causationId" uuid NOT NULL,
  "payload" jsonb NOT NULL, "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING', "attempts" integer NOT NULL DEFAULT 0,
  "nextAttemptAt" timestamptz(3) NOT NULL, "claimToken" uuid, "leaseUntil" timestamptz(3), "createdAt" timestamptz(3) NOT NULL, "publishedAt" timestamptz(3),
  CONSTRAINT "NotificationOutboxEvent_id_v7" CHECK ("notification_uuid_is_v7"("id")),
  CONSTRAINT "NotificationOutboxEvent_trace_check" CHECK ("traceId" ~ '^[a-f0-9]{32}$'),
  CONSTRAINT "NotificationOutboxEvent_attempts_check" CHECK ("attempts" >= 0)
);
CREATE INDEX "NotificationOutboxEvent_delivery_idx" ON "NotificationOutboxEvent" ("status", "nextAttemptAt", "leaseUntil");

CREATE TABLE "OperatorQueueItem" (
  "id" uuid PRIMARY KEY, "notificationId" uuid NOT NULL REFERENCES "Notification"("id") ON DELETE RESTRICT,
  "reasonCode" varchar(128) NOT NULL, "status" "OperatorQueueStatus" NOT NULL DEFAULT 'OPEN', "createdAt" timestamptz(3) NOT NULL, "resolvedAt" timestamptz(3),
  CONSTRAINT "OperatorQueueItem_id_v7" CHECK ("notification_uuid_is_v7"("id")),
  CONSTRAINT "OperatorQueueItem_notification_reason_key" UNIQUE ("notificationId", "reasonCode")
);
CREATE INDEX "OperatorQueueItem_status_created_idx" ON "OperatorQueueItem" ("status", "createdAt");

CREATE FUNCTION "notification_template_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'PUBLISHED_TEMPLATE_IMMUTABLE'; END $$;
CREATE TRIGGER "NotificationTemplateVersion_immutable" BEFORE UPDATE OR DELETE ON "NotificationTemplateVersion" FOR EACH ROW EXECUTE FUNCTION "notification_template_immutable"();

-- Canonical database worker claim: unique constraints provide idempotency and SKIP LOCKED/CAS provides concurrency safety.
CREATE FUNCTION "claim_next_notification"(claim uuid, leased_until timestamptz, now_at timestamptz)
RETURNS SETOF "Notification" LANGUAGE plpgsql AS $$
BEGIN
  RETURN QUERY
  WITH candidate AS (
    SELECT n."id" FROM "Notification" n
    WHERE ((n."status" IN ('PENDING','RETRY_PENDING') AND n."nextAttemptAt" <= now_at)
       OR (n."status" = 'RECONCILING' AND n."nextAttemptAt" <= now_at AND (n."leaseUntil" IS NULL OR n."leaseUntil" <= now_at)))
    ORDER BY n."nextAttemptAt", n."id" FOR UPDATE SKIP LOCKED LIMIT 1
  )
  UPDATE "Notification" n SET "status" = 'RECONCILING', "claimToken" = claim, "leaseUntil" = leased_until,
    "sendStartedAt" = CASE WHEN n."status" IN ('PENDING','RETRY_PENDING') THEN now_at ELSE n."sendStartedAt" END,
    "sendDate" = CASE WHEN n."status" IN ('PENDING','RETRY_PENDING') THEN to_char(now_at AT TIME ZONE 'Asia/Shanghai', 'YYYYMMDD') ELSE n."sendDate" END,
    "reconciliationAttempts" = CASE WHEN n."status" = 'RECONCILING' THEN n."reconciliationAttempts" + 1 ELSE n."reconciliationAttempts" END,
    "attempts" = CASE WHEN n."status" = 'RECONCILING' THEN n."attempts" ELSE n."attempts" + 1 END
  FROM candidate c WHERE n."id" = c."id" AND (n."claimToken" IS NULL OR n."leaseUntil" <= now_at)
  RETURNING n.*;
END $$;
