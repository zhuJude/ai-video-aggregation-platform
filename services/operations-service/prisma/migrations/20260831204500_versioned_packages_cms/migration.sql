-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "ContentKind" AS ENUM ('BANNER', 'ANNOUNCEMENT', 'HELP', 'CASE_STUDY', 'LEGAL');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TicketMessageAuthorType" AS ENUM ('USER', 'AGENT');

-- CreateEnum
CREATE TYPE "FeedbackKind" AS ENUM ('MODEL_RESULT', 'FAILED_TASK', 'PRODUCT_SUGGESTION');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'FAILED', 'PUBLISHED');

-- CreateTable
CREATE TABLE "RechargePackageVersion" (
    "id" UUID NOT NULL,
    "packageId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "basePublishedVersionId" UUID,
    "name" VARCHAR(120) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "points" BIGINT NOT NULL,
    "bonusPoints" BIGINT NOT NULL,
    "purchaseLimit" INTEGER,
    "validityDays" INTEGER,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "activeFrom" TIMESTAMPTZ(3),
    "activeUntil" TIMESTAMPTZ(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "RechargePackageVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RechargePackagePurchaseSnapshot" (
    "purchaseId" UUID NOT NULL,
    "packageVersionId" UUID NOT NULL,
    "buyerId" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "amountMinor" BIGINT NOT NULL,
    "currency" CHAR(3) NOT NULL,
    "points" BIGINT NOT NULL,
    "bonusPoints" BIGINT NOT NULL,
    "purchaseLimit" INTEGER,
    "validityDays" INTEGER,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RechargePackagePurchaseSnapshot_pkey" PRIMARY KEY ("purchaseId")
);

-- CreateTable
CREATE TABLE "ContentEntry" (
    "id" UUID NOT NULL,
    "kind" "ContentKind" NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentVersion" (
    "id" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "basePublishedVersionId" UUID,
    "title" VARCHAR(200) NOT NULL,
    "summary" VARCHAR(1000) NOT NULL,
    "bodyHtml" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "activeFrom" TIMESTAMPTZ(3),
    "activeUntil" TIMESTAMPTZ(3),
    "helpCategoryId" UUID,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "ContentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BannerPlacement" (
    "id" UUID NOT NULL,
    "contentVersionId" UUID NOT NULL,
    "slot" VARCHAR(64) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "activeFrom" TIMESTAMPTZ(3),
    "activeUntil" TIMESTAMPTZ(3),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BannerPlacement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BannerSlotRevision" (
    "slot" VARCHAR(64) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "BannerSlotRevision_pkey" PRIMARY KEY ("slot")
);

-- CreateTable
CREATE TABLE "HelpCategory" (
    "id" UUID NOT NULL,
    "key" VARCHAR(128) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HelpCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeatureFlagVersion" (
    "id" UUID NOT NULL,
    "flagKey" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "basePublishedVersionId" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "rules" JSONB NOT NULL,
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "FeatureFlagVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublicSystemSettingVersion" (
    "id" UUID NOT NULL,
    "settingKey" VARCHAR(128) NOT NULL,
    "version" INTEGER NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "basePublishedVersionId" UUID,
    "publicValue" JSONB,
    "kmsSecretReferenceId" VARCHAR(300),
    "createdBy" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "retiredAt" TIMESTAMPTZ(3),

    CONSTRAINT "PublicSystemSettingVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ticket" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "subject" VARCHAR(200) NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "assigneeId" UUID,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketMessage" (
    "id" UUID NOT NULL,
    "ticketId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "authorType" "TicketMessageAuthorType" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TicketMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Feedback" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "kind" "FeedbackKind" NOT NULL,
    "taskId" UUID,
    "content" TEXT NOT NULL,
    "rating" INTEGER,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "type" VARCHAR(160) NOT NULL,
    "version" INTEGER NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "traceId" CHAR(32) NOT NULL,
    "correlationId" UUID NOT NULL,
    "causationId" UUID,
    "producer" VARCHAR(80) NOT NULL,
    "data" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimToken" UUID,
    "leaseUntil" TIMESTAMPTZ(3),
    "lastError" VARCHAR(80),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RechargePackageVersion_status_activeFrom_activeUntil_sortOr_idx" ON "RechargePackageVersion"("status", "activeFrom", "activeUntil", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "RechargePackageVersion_packageId_version_key" ON "RechargePackageVersion"("packageId", "version");

CREATE UNIQUE INDEX "RechargePackageVersion_one_published_key" ON "RechargePackageVersion"("packageId") WHERE "status" = 'PUBLISHED';

-- CreateIndex
CREATE INDEX "RechargePackagePurchaseSnapshot_buyerId_capturedAt_idx" ON "RechargePackagePurchaseSnapshot"("buyerId", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentEntry_kind_key_key" ON "ContentEntry"("kind", "key");

-- CreateIndex
CREATE INDEX "ContentVersion_status_activeFrom_activeUntil_sortOrder_idx" ON "ContentVersion"("status", "activeFrom", "activeUntil", "sortOrder");

-- CreateIndex
CREATE INDEX "ContentVersion_helpCategoryId_status_sortOrder_idx" ON "ContentVersion"("helpCategoryId", "status", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "ContentVersion_entryId_version_key" ON "ContentVersion"("entryId", "version");

CREATE UNIQUE INDEX "ContentVersion_one_published_key" ON "ContentVersion"("entryId") WHERE "status" = 'PUBLISHED';

-- CreateIndex
CREATE INDEX "BannerPlacement_slot_activeFrom_activeUntil_sortOrder_idx" ON "BannerPlacement"("slot", "activeFrom", "activeUntil", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "BannerPlacement_slot_contentVersionId_key" ON "BannerPlacement"("slot", "contentVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "HelpCategory_key_key" ON "HelpCategory"("key");

-- CreateIndex
CREATE INDEX "HelpCategory_active_sortOrder_idx" ON "HelpCategory"("active", "sortOrder");

-- CreateIndex
CREATE INDEX "FeatureFlagVersion_flagKey_status_idx" ON "FeatureFlagVersion"("flagKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "FeatureFlagVersion_flagKey_version_key" ON "FeatureFlagVersion"("flagKey", "version");

CREATE UNIQUE INDEX "FeatureFlagVersion_one_published_key" ON "FeatureFlagVersion"("flagKey") WHERE "status" = 'PUBLISHED';

-- CreateIndex
CREATE INDEX "PublicSystemSettingVersion_settingKey_status_idx" ON "PublicSystemSettingVersion"("settingKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PublicSystemSettingVersion_settingKey_version_key" ON "PublicSystemSettingVersion"("settingKey", "version");

CREATE UNIQUE INDEX "PublicSystemSettingVersion_one_published_key" ON "PublicSystemSettingVersion"("settingKey") WHERE "status" = 'PUBLISHED';

-- CreateIndex
CREATE INDEX "Ticket_userId_createdAt_idx" ON "Ticket"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Ticket_status_assigneeId_updatedAt_idx" ON "Ticket"("status", "assigneeId", "updatedAt");

-- CreateIndex
CREATE INDEX "TicketMessage_ticketId_createdAt_idx" ON "TicketMessage"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_userId_createdAt_idx" ON "Feedback"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "Feedback_kind_createdAt_idx" ON "Feedback"("kind", "createdAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_leaseUntil_idx" ON "OutboxEvent"("leaseUntil");

-- AddForeignKey
ALTER TABLE "RechargePackagePurchaseSnapshot" ADD CONSTRAINT "RechargePackagePurchaseSnapshot_packageVersionId_fkey" FOREIGN KEY ("packageVersionId") REFERENCES "RechargePackageVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "ContentEntry"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_helpCategoryId_fkey" FOREIGN KEY ("helpCategoryId") REFERENCES "HelpCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BannerPlacement" ADD CONSTRAINT "BannerPlacement_contentVersionId_fkey" FOREIGN KEY ("contentVersionId") REFERENCES "ContentVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "Ticket"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Domain invariants that Prisma cannot express.
CREATE FUNCTION "uuid_is_v7"(value uuid) RETURNS boolean AS $$
  SELECT substring(value::text from 15 for 1) = '7'
    AND substring(value::text from 20 for 1) ~ '^[89ab]$';
$$ LANGUAGE sql IMMUTABLE STRICT;

ALTER TABLE "RechargePackageVersion"
  ADD CONSTRAINT "RechargePackageVersion_amounts_check" CHECK ("amountMinor" > 0 AND "points" > 0 AND "bonusPoints" >= 0),
  ADD CONSTRAINT "RechargePackageVersion_currency_check" CHECK ("currency" = 'CNY'),
  ADD CONSTRAINT "RechargePackageVersion_uuidv7_check" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("packageId")),
  ADD CONSTRAINT "RechargePackageVersion_limits_check" CHECK (("purchaseLimit" IS NULL OR "purchaseLimit" > 0) AND ("validityDays" IS NULL OR "validityDays" > 0)),
  ADD CONSTRAINT "RechargePackageVersion_window_check" CHECK ("activeFrom" IS NULL OR "activeUntil" IS NULL OR "activeFrom" < "activeUntil"),
  ADD CONSTRAINT "RechargePackageVersion_revision_check" CHECK ("revision" >= 0);

ALTER TABLE "ContentVersion"
  ADD CONSTRAINT "ContentVersion_window_check" CHECK ("activeFrom" IS NULL OR "activeUntil" IS NULL OR "activeFrom" < "activeUntil"),
  ADD CONSTRAINT "ContentVersion_revision_check" CHECK ("revision" >= 0);

ALTER TABLE "BannerPlacement"
  ADD CONSTRAINT "BannerPlacement_window_check" CHECK ("activeFrom" IS NULL OR "activeUntil" IS NULL OR "activeFrom" < "activeUntil");

ALTER TABLE "PublicSystemSettingVersion"
  ADD CONSTRAINT "PublicSystemSettingVersion_one_value_check" CHECK ((("publicValue" IS NOT NULL)::integer + ("kmsSecretReferenceId" IS NOT NULL)::integer) = 1),
  ADD CONSTRAINT "PublicSystemSettingVersion_kms_reference_check" CHECK ("kmsSecretReferenceId" IS NULL OR "kmsSecretReferenceId" ~ '^kms://[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$'),
  ADD CONSTRAINT "PublicSystemSettingVersion_raw_secret_check" CHECK ("publicValue" IS NULL OR "settingKey" IN ('site.publicConfig', 'site.maintenanceMessage', 'support.email', 'cdn.publicBaseUrl', 'legal.privacyPolicyUrl', 'legal.termsUrl')),
  ADD CONSTRAINT "PublicSystemSettingVersion_revision_check" CHECK ("revision" >= 0);

ALTER TABLE "FeatureFlagVersion" ADD CONSTRAINT "FeatureFlagVersion_revision_check" CHECK ("revision" >= 0);
ALTER TABLE "BannerSlotRevision" ADD CONSTRAINT "BannerSlotRevision_revision_check" CHECK ("revision" >= 0);
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_rating_check" CHECK ("rating" IS NULL OR "rating" BETWEEN 1 AND 5);

ALTER TABLE "RechargePackageVersion" ADD CONSTRAINT "RechargePackageVersion_uuid_columns_v7" CHECK ("uuid_is_v7"("createdBy") AND ("basePublishedVersionId" IS NULL OR "uuid_is_v7"("basePublishedVersionId")));
ALTER TABLE "RechargePackagePurchaseSnapshot" ADD CONSTRAINT "RechargePackagePurchaseSnapshot_uuid_columns_v7" CHECK ("uuid_is_v7"("packageVersionId") AND "uuid_is_v7"("buyerId"));
ALTER TABLE "ContentEntry" ADD CONSTRAINT "ContentEntry_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("createdBy"));
ALTER TABLE "ContentVersion" ADD CONSTRAINT "ContentVersion_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("entryId") AND "uuid_is_v7"("createdBy") AND ("basePublishedVersionId" IS NULL OR "uuid_is_v7"("basePublishedVersionId")) AND ("helpCategoryId" IS NULL OR "uuid_is_v7"("helpCategoryId")));
ALTER TABLE "BannerPlacement" ADD CONSTRAINT "BannerPlacement_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("contentVersionId") AND "uuid_is_v7"("createdBy"));
ALTER TABLE "HelpCategory" ADD CONSTRAINT "HelpCategory_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("createdBy"));
ALTER TABLE "FeatureFlagVersion" ADD CONSTRAINT "FeatureFlagVersion_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("createdBy") AND ("basePublishedVersionId" IS NULL OR "uuid_is_v7"("basePublishedVersionId")));
ALTER TABLE "PublicSystemSettingVersion" ADD CONSTRAINT "PublicSystemSettingVersion_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("createdBy") AND ("basePublishedVersionId" IS NULL OR "uuid_is_v7"("basePublishedVersionId")));
ALTER TABLE "Ticket" ADD CONSTRAINT "Ticket_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("userId") AND ("assigneeId" IS NULL OR "uuid_is_v7"("assigneeId")));
ALTER TABLE "TicketMessage" ADD CONSTRAINT "TicketMessage_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("ticketId") AND "uuid_is_v7"("authorId"));
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_uuid_columns_v7" CHECK ("uuid_is_v7"("id") AND "uuid_is_v7"("userId") AND ("taskId" IS NULL OR "uuid_is_v7"("taskId")));

ALTER TABLE "RechargePackagePurchaseSnapshot"
  ADD CONSTRAINT "RechargePackagePurchaseSnapshot_currency_check" CHECK ("currency" = 'CNY'),
  ADD CONSTRAINT "RechargePackagePurchaseSnapshot_purchase_uuidv7_check" CHECK ("uuid_is_v7"("purchaseId"));

ALTER TABLE "OutboxEvent"
  ADD CONSTRAINT "OutboxEvent_envelope_check" CHECK (
    "version" > 0 AND "type" ~ '^[a-z][a-z0-9.-]+\.v[0-9]+$' AND "traceId" ~ '^[a-f0-9]{32}$'
    AND "uuid_is_v7"("id") AND "uuid_is_v7"("correlationId")
    AND ("causationId" IS NULL OR "uuid_is_v7"("causationId"))
    AND ("claimToken" IS NULL OR "uuid_is_v7"("claimToken"))
  );

CREATE FUNCTION "enforce_published_version_immutability"() RETURNS trigger AS $$
BEGIN
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE = '40001';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" NOT IN ('DRAFT', 'PUBLISHED') THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'PUBLISHED' AND NEW."status" NOT IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'RETIRED' THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW."retiredAt" IS DISTINCT FROM OLD."retiredAt" AND NOT (
    OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED' AND OLD."retiredAt" IS NULL AND NEW."retiredAt" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'PUBLISHED' AND NEW."status" = 'RETIRED' AND NEW."retiredAt" IS NULL THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" = 'DRAFT' AND NEW."status" = 'PUBLISHED' AND NEW."retiredAt" IS NOT NULL THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF OLD."status" IN ('PUBLISHED', 'RETIRED') AND
     (to_jsonb(NEW) - ARRAY['revision', 'status', 'retiredAt']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['revision', 'status', 'retiredAt']) THEN
    RAISE EXCEPTION 'PUBLISHED_VERSION_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RechargePackageVersion_immutable" BEFORE UPDATE ON "RechargePackageVersion"
  FOR EACH ROW EXECUTE FUNCTION "enforce_published_version_immutability"();
CREATE TRIGGER "ContentVersion_immutable" BEFORE UPDATE ON "ContentVersion"
  FOR EACH ROW EXECUTE FUNCTION "enforce_published_version_immutability"();
CREATE TRIGGER "FeatureFlagVersion_immutable" BEFORE UPDATE ON "FeatureFlagVersion"
  FOR EACH ROW EXECUTE FUNCTION "enforce_published_version_immutability"();
CREATE TRIGGER "PublicSystemSettingVersion_immutable" BEFORE UPDATE ON "PublicSystemSettingVersion"
  FOR EACH ROW EXECUTE FUNCTION "enforce_published_version_immutability"();

CREATE FUNCTION "reject_immutable_snapshot_change"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PACKAGE_SNAPSHOT_IMMUTABLE' USING ERRCODE = '23514';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RechargePackagePurchaseSnapshot_immutable" BEFORE UPDATE OR DELETE ON "RechargePackagePurchaseSnapshot"
  FOR EACH ROW EXECUTE FUNCTION "reject_immutable_snapshot_change"();
