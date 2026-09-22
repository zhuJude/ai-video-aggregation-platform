-- Secure support tickets. State transitions are:
-- OPEN -> IN_PROGRESS -> RESOLVED -> CLOSED, with RESOLVED -> IN_PROGRESS
-- allowed for seven days. Internal notes intentionally have no outbox relation.

ALTER TABLE "TicketMessage"
  ADD COLUMN "idempotencyKey" VARCHAR(128),
  ADD COLUMN "requestHash" CHAR(64),
  ADD COLUMN "resolutionCycle" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Ticket"
  ADD COLUMN "resolutionCycle" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "responseRequiredSince" TIMESTAMPTZ(3);
UPDATE "Ticket" SET "responseRequiredSince" = "createdAt" WHERE "responseRequiredSince" IS NULL;
ALTER TABLE "Ticket" ALTER COLUMN "responseRequiredSince" SET NOT NULL;
ALTER TABLE "Ticket" ALTER COLUMN "responseRequiredSince" SET DEFAULT CURRENT_TIMESTAMP;

CREATE TABLE "TicketMessageAttachment" (
  "id" UUID NOT NULL,
  "messageId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "supportUploadSessionId" UUID,
  CONSTRAINT "TicketMessageAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TicketInternalNote" (
  "id" UUID NOT NULL,
  "ticketId" UUID NOT NULL,
  "authorId" UUID NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TicketInternalNote_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "FeedbackAttachment" (
  "id" UUID NOT NULL,
  "feedbackId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "supportUploadSessionId" UUID,
  CONSTRAINT "FeedbackAttachment_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportUploadConsumption" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "sourceType" VARCHAR(24) NOT NULL,
  "sourceId" UUID NOT NULL,
  "consumedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "SupportUploadConsumption_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportUploadBinding" (
  "id" UUID NOT NULL,
  "operationId" VARCHAR(160) NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 0,
  "remoteOperationId" UUID NOT NULL,
  "fence" UUID NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "reservationId" VARCHAR(160),
  "ownershipToken" VARCHAR(256),
  "sessionId" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "sourceType" VARCHAR(24),
  "sourceId" UUID,
  "status" VARCHAR(24) NOT NULL DEFAULT 'RESERVING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
  "claimToken" UUID,
  "leaseUntil" TIMESTAMPTZ(3),
  "lastError" VARCHAR(160),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finalizedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SupportUploadBinding_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SupportUploadCompensation" (
  "id" UUID NOT NULL,
  "compensationKey" CHAR(64) NOT NULL,
  "reservationId" VARCHAR(160) NOT NULL,
  "operationId" VARCHAR(160) NOT NULL,
  "remoteOperationId" VARCHAR(160) NOT NULL,
  "generation" INTEGER NOT NULL,
  "fence" VARCHAR(160) NOT NULL,
  "requestHash" VARCHAR(128) NOT NULL,
  "ownershipToken" VARCHAR(256) NOT NULL,
  "sessionId" VARCHAR(160) NOT NULL,
  "ownerId" VARCHAR(160) NOT NULL,
  "assetId" VARCHAR(160) NOT NULL,
  "purpose" VARCHAR(64) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'RELEASE_PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL,
  "claimToken" UUID,
  "leaseUntil" TIMESTAMPTZ(3),
  "lastError" VARCHAR(160),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SupportUploadCompensation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TicketMessage_idempotency_key" ON "TicketMessage"("ticketId", "authorId", "idempotencyKey");
CREATE UNIQUE INDEX "TicketMessageAttachment_messageId_assetId_key" ON "TicketMessageAttachment"("messageId", "assetId");
CREATE INDEX "TicketMessageAttachment_assetId_idx" ON "TicketMessageAttachment"("assetId");
CREATE INDEX "TicketInternalNote_ticketId_createdAt_idx" ON "TicketInternalNote"("ticketId", "createdAt");
CREATE UNIQUE INDEX "FeedbackAttachment_feedbackId_assetId_key" ON "FeedbackAttachment"("feedbackId", "assetId");
CREATE INDEX "FeedbackAttachment_assetId_idx" ON "FeedbackAttachment"("assetId");
CREATE UNIQUE INDEX "SupportUploadConsumption_sessionId_key" ON "SupportUploadConsumption"("sessionId");
CREATE INDEX "SupportUploadConsumption_ownerId_consumedAt_idx" ON "SupportUploadConsumption"("ownerId", "consumedAt");
CREATE UNIQUE INDEX "SupportUploadBinding_operationId_key" ON "SupportUploadBinding"("operationId");
CREATE UNIQUE INDEX "SupportUploadBinding_remoteOperationId_key" ON "SupportUploadBinding"("remoteOperationId");
CREATE UNIQUE INDEX "SupportUploadBinding_sessionId_key" ON "SupportUploadBinding"("sessionId");
CREATE INDEX "SupportUploadBinding_status_nextAttemptAt_idx" ON "SupportUploadBinding"("status", "nextAttemptAt");
CREATE UNIQUE INDEX "SupportUploadCompensation_compensationKey_key" ON "SupportUploadCompensation"("compensationKey");
CREATE INDEX "SupportUploadCompensation_status_nextAttemptAt_idx" ON "SupportUploadCompensation"("status", "nextAttemptAt");

ALTER TABLE "TicketMessageAttachment" ADD CONSTRAINT "TicketMessageAttachment_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "TicketMessage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TicketInternalNote" ADD CONSTRAINT "TicketInternalNote_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "FeedbackAttachment" ADD CONSTRAINT "FeedbackAttachment_feedbackId_fkey" FOREIGN KEY ("feedbackId") REFERENCES "Feedback"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Ticket"
  ADD CONSTRAINT "Ticket_revision_nonnegative_check" CHECK ("revision" >= 0),
  ADD CONSTRAINT "Ticket_resolution_cycle_nonnegative_check" CHECK ("resolutionCycle" >= 0),
  ADD CONSTRAINT "Ticket_subject_check" CHECK (char_length(btrim("subject")) BETWEEN 1 AND 200),
  ADD CONSTRAINT "Ticket_status_timestamps_check" CHECK (
    ("status" IN ('OPEN', 'IN_PROGRESS') AND "resolvedAt" IS NULL AND "closedAt" IS NULL)
    OR ("status" = 'RESOLVED' AND "resolvedAt" IS NOT NULL AND "closedAt" IS NULL)
    OR ("status" = 'CLOSED' AND "resolvedAt" IS NOT NULL AND "closedAt" IS NOT NULL)
  );

ALTER TABLE "TicketMessage"
  ADD CONSTRAINT "TicketMessage_resolution_cycle_nonnegative_check" CHECK ("resolutionCycle" >= 0),
  ADD CONSTRAINT "TicketMessage_idempotency_pair_check" CHECK (("idempotencyKey" IS NULL) = ("requestHash" IS NULL)),
  ADD CONSTRAINT "TicketMessage_request_hash_check" CHECK ("requestHash" IS NULL OR "requestHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "TicketMessage_body_check" CHECK (char_length(btrim("body")) BETWEEN 1 AND 10000);

ALTER TABLE "TicketMessageAttachment"
  ADD CONSTRAINT "TicketMessageAttachment_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("messageId") AND "uuid_is_v7"("assetId") AND ("supportUploadSessionId" IS NULL OR "uuid_is_v7"("supportUploadSessionId")));
ALTER TABLE "TicketInternalNote"
  ADD CONSTRAINT "TicketInternalNote_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("ticketId") AND "uuid_is_v7"("authorId")),
  ADD CONSTRAINT "TicketInternalNote_body_check" CHECK (char_length(btrim("body")) BETWEEN 1 AND 10000);
ALTER TABLE "Feedback"
  ADD CONSTRAINT "Feedback_content_check" CHECK (char_length(btrim("content")) BETWEEN 1 AND 5000),
  ADD CONSTRAINT "Feedback_task_subject_check" CHECK ("kind" = 'PRODUCT_SUGGESTION' OR "taskId" IS NOT NULL);
ALTER TABLE "FeedbackAttachment"
  ADD CONSTRAINT "FeedbackAttachment_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("feedbackId") AND "uuid_is_v7"("assetId") AND ("supportUploadSessionId" IS NULL OR "uuid_is_v7"("supportUploadSessionId")));
ALTER TABLE "SupportUploadConsumption"
  ADD CONSTRAINT "SupportUploadConsumption_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("sessionId") AND "uuid_is_v7"("ownerId") AND "uuid_is_v7"("assetId") AND "uuid_is_v7"("sourceId")),
  ADD CONSTRAINT "SupportUploadConsumption_source_type_check" CHECK ("sourceType" IN ('TICKET_MESSAGE', 'FEEDBACK'));
ALTER TABLE "SupportUploadBinding"
  ADD CONSTRAINT "SupportUploadBinding_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("remoteOperationId") AND "uuid_is_v7"("fence") AND "uuid_is_v7"("sessionId") AND "uuid_is_v7"("ownerId") AND "uuid_is_v7"("assetId") AND ("sourceId" IS NULL OR "uuid_is_v7"("sourceId")) AND ("claimToken" IS NULL OR "uuid_is_v7"("claimToken"))),
  ADD CONSTRAINT "SupportUploadBinding_generation_check" CHECK ("generation" >= 0),
  ADD CONSTRAINT "SupportUploadBinding_request_hash_check" CHECK ("requestHash" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "SupportUploadBinding_status_check" CHECK ("status" IN ('RESERVING', 'RESERVED', 'FINALIZE_PENDING', 'FINALIZED', 'RELEASE_PENDING', 'RELEASED', 'CANCELLED')),
  ADD CONSTRAINT "SupportUploadBinding_source_type_check" CHECK ("sourceType" IS NULL OR "sourceType" IN ('TICKET_MESSAGE', 'FEEDBACK')),
  ADD CONSTRAINT "SupportUploadBinding_source_pair_check" CHECK (("sourceType" IS NULL) = ("sourceId" IS NULL)),
  ADD CONSTRAINT "SupportUploadBinding_state_check" CHECK (
    ("status" = 'RESERVING' AND "reservationId" IS NULL AND "ownershipToken" IS NULL AND "sourceId" IS NULL)
    OR ("status" = 'RESERVED' AND "reservationId" IS NOT NULL AND "ownershipToken" IS NOT NULL AND "sourceId" IS NULL)
    OR ("status" IN ('FINALIZE_PENDING', 'FINALIZED') AND "reservationId" IS NOT NULL AND "ownershipToken" IS NOT NULL AND "sourceId" IS NOT NULL)
    OR ("status" IN ('RELEASE_PENDING', 'RELEASED', 'CANCELLED') AND "sourceId" IS NULL)
  );
ALTER TABLE "SupportUploadCompensation"
  ADD CONSTRAINT "SupportUploadCompensation_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND ("claimToken" IS NULL OR "uuid_is_v7"("claimToken"))),
  ADD CONSTRAINT "SupportUploadCompensation_key_check" CHECK ("compensationKey" ~ '^[a-f0-9]{64}$'),
  ADD CONSTRAINT "SupportUploadCompensation_status_check" CHECK ("status" IN ('RELEASE_PENDING', 'RELEASED'));

CREATE FUNCTION "enforce_ticket_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'TICKET_REVISION_CONFLICT' USING ERRCODE = '40001';
  END IF;

  IF NEW."status" <> OLD."status" AND NOT (
    (OLD."status" = 'OPEN' AND NEW."status" = 'IN_PROGRESS') OR
    (OLD."status" = 'IN_PROGRESS' AND NEW."status" = 'RESOLVED') OR
    (OLD."status" = 'RESOLVED' AND NEW."status" = 'IN_PROGRESS') OR
    (OLD."status" = 'RESOLVED' AND NEW."status" = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'TICKET_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;

  IF OLD."status" = 'RESOLVED' AND NEW."status" = 'IN_PROGRESS' AND clock_timestamp() > OLD."resolvedAt" + INTERVAL '7 days' THEN
    RAISE EXCEPTION 'TICKET_REOPEN_WINDOW_EXPIRED' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = 'RESOLVED' AND OLD."status" <> 'RESOLVED' AND NOT EXISTS (
    SELECT 1 FROM "TicketMessage" message WHERE message."ticketId" = NEW."id" AND message."authorType" = 'AGENT'
      AND message."resolutionCycle" = NEW."resolutionCycle" AND message."createdAt" >= NEW."responseRequiredSince"
  ) THEN
    RAISE EXCEPTION 'TICKET_REPLY_REQUIRED' USING ERRCODE = '23514';
  END IF;

  IF NEW."status" = OLD."status" AND (NEW."resolvedAt" IS DISTINCT FROM OLD."resolvedAt" OR NEW."closedAt" IS DISTINCT FROM OLD."closedAt") THEN
    RAISE EXCEPTION 'TICKET_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;
  IF NOT (OLD."status" = 'RESOLVED' AND NEW."status" = 'IN_PROGRESS') AND (NEW."resolutionCycle" <> OLD."resolutionCycle" OR NEW."responseRequiredSince" IS DISTINCT FROM OLD."responseRequiredSince") THEN
    RAISE EXCEPTION 'TICKET_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'RESOLVED' AND NEW."status" = 'IN_PROGRESS' AND (NEW."resolutionCycle" <> OLD."resolutionCycle" + 1 OR NEW."responseRequiredSince" <= OLD."responseRequiredSince") THEN
    RAISE EXCEPTION 'TICKET_INVALID_TRANSITION' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Ticket_transition_guard"
BEFORE UPDATE ON "Ticket"
FOR EACH ROW EXECUTE FUNCTION "enforce_ticket_transition"();
