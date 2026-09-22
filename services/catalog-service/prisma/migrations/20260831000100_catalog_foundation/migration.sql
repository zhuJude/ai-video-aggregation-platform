CREATE TYPE "ProviderStatus" AS ENUM ('ACTIVE', 'MAINTENANCE', 'DISABLED');
CREATE TYPE "ModelStatus" AS ENUM ('DRAFT', 'ACTIVE', 'MAINTENANCE', 'DISABLED');
CREATE TYPE "CapabilityStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

CREATE TABLE "Provider" (
  "id" UUID PRIMARY KEY,
  "code" TEXT NOT NULL UNIQUE,
  "displayName" TEXT NOT NULL,
  "apiBaseUrl" TEXT NOT NULL,
  "status" "ProviderStatus" NOT NULL DEFAULT 'ACTIVE',
  "maintenanceStartsAt" TIMESTAMPTZ(3),
  "maintenanceEndsAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL
);

CREATE TABLE "ProviderCredentialRef" (
  "id" UUID PRIMARY KEY,
  "providerId" UUID NOT NULL REFERENCES "Provider"("id") ON DELETE RESTRICT,
  "kmsKeyReference" TEXT NOT NULL,
  "scope" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotatedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ProviderCredentialRef_providerId_scope_key" UNIQUE ("providerId", "scope")
);

CREATE TABLE "Model" (
  "id" UUID PRIMARY KEY,
  "providerId" UUID NOT NULL REFERENCES "Provider"("id") ON DELETE RESTRICT,
  "code" TEXT NOT NULL,
  "providerModelId" TEXT NOT NULL,
  "displayName" TEXT NOT NULL,
  "description" TEXT,
  "coverUrl" TEXT,
  "sortOrder" INTEGER NOT NULL DEFAULT 0,
  "status" "ModelStatus" NOT NULL DEFAULT 'DRAFT',
  "maintenanceStartsAt" TIMESTAMPTZ(3),
  "maintenanceEndsAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Model_providerId_code_key" UNIQUE ("providerId", "code")
);
CREATE INDEX "Model_status_sortOrder_idx" ON "Model"("status", "sortOrder");

CREATE TABLE "CapabilityVersion" (
  "id" UUID PRIMARY KEY,
  "modelId" UUID NOT NULL REFERENCES "Model"("id") ON DELETE RESTRICT,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "status" "CapabilityStatus" NOT NULL DEFAULT 'DRAFT',
  "document" JSONB NOT NULL,
  "contentSha256" CHAR(64),
  "publishedAt" TIMESTAMPTZ(3),
  "publishedBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CapabilityVersion_modelId_version_key" UNIQUE ("modelId", "version"),
  CONSTRAINT "CapabilityVersion_publication_fields_check" CHECK (
    ("status" = 'DRAFT' AND "publishedAt" IS NULL AND "publishedBy" IS NULL AND "contentSha256" IS NULL)
    OR
    ("status" <> 'DRAFT' AND "publishedAt" IS NOT NULL AND "publishedBy" IS NOT NULL AND "contentSha256" ~ '^[a-f0-9]{64}$')
  )
);
CREATE INDEX "CapabilityVersion_modelId_status_idx" ON "CapabilityVersion"("modelId", "status");

CREATE TABLE "CapabilityPublication" (
  "id" UUID PRIMARY KEY,
  "capabilityVersionId" UUID NOT NULL REFERENCES "CapabilityVersion"("id") ON DELETE RESTRICT,
  "publishedAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedBy" UUID NOT NULL,
  "contentSha256" CHAR(64) NOT NULL
);
CREATE INDEX "CapabilityPublication_capabilityVersionId_publishedAt_idx"
  ON "CapabilityPublication"("capabilityVersionId", "publishedAt");

CREATE TABLE "OutboxEvent" (
  "id" UUID PRIMARY KEY,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" UUID NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "OutboxEvent_publishedAt_occurredAt_idx" ON "OutboxEvent"("publishedAt", "occurredAt");

CREATE FUNCTION prevent_published_capability_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'CAPABILITY_VERSION_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CapabilityVersion_immutable_after_publication"
BEFORE UPDATE OR DELETE ON "CapabilityVersion"
FOR EACH ROW EXECUTE FUNCTION prevent_published_capability_mutation();
