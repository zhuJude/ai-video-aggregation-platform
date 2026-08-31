-- Durable import reservation prevents provider result replays from copying or publishing twice.
CREATE TABLE "ResultImport" (
    "id" UUID NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "authorizationId" UUID NOT NULL,
    "reservedObjectKey" TEXT,
    "assetId" UUID,
    "status" TEXT NOT NULL DEFAULT 'RESERVED',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "importedAt" TIMESTAMPTZ(3),
    "failedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "claimToken" TEXT,
    "leaseUntil" TIMESTAMPTZ(3),
    CONSTRAINT "ResultImport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ResultImport_idempotencyKey_key" ON "ResultImport"("idempotencyKey");
CREATE UNIQUE INDEX "ResultImport_assetId_key" ON "ResultImport"("assetId");
CREATE INDEX "ResultImport_ownerId_status_createdAt_idx" ON "ResultImport"("ownerId", "status", "createdAt");
ALTER TABLE "ResultImport" ADD CONSTRAINT "ResultImport_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "AssetDeletion_assetId_key" ON "AssetDeletion"("assetId");

-- Retention timestamps distinguish 24-hour temporary uploads from seven-day failed artifacts.
ALTER TABLE "Asset" ADD COLUMN "temporaryExpiresAt" TIMESTAMPTZ(3), ADD COLUMN "failedTemporaryExpiresAt" TIMESTAMPTZ(3);
CREATE INDEX "Asset_temporaryExpiresAt_idx" ON "Asset"("temporaryExpiresAt");
CREATE INDEX "Asset_failedTemporaryExpiresAt_idx" ON "Asset"("failedTemporaryExpiresAt");

CREATE TABLE "AssetCleanup" (
    "id" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    CONSTRAINT "AssetCleanup_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AssetCleanup_objectKey_key" ON "AssetCleanup"("objectKey");
CREATE INDEX "AssetCleanup_deletedAt_scheduledAt_idx" ON "AssetCleanup"("deletedAt", "scheduledAt");
ALTER TABLE "AssetDeletion" ADD COLUMN "claimToken" TEXT, ADD COLUMN "leaseUntil" TIMESTAMPTZ(3);
ALTER TABLE "AssetCleanup" ADD COLUMN "claimToken" TEXT, ADD COLUMN "leaseUntil" TIMESTAMPTZ(3);
ALTER TABLE "OutboxEvent" ADD COLUMN "claimToken" TEXT, ADD COLUMN "leaseUntil" TIMESTAMPTZ(3);
ALTER TABLE "OutboxEvent" ADD COLUMN "nextAttemptAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX "OutboxEvent_status_nextAttemptAt_idx" ON "OutboxEvent"("status", "nextAttemptAt");

-- Provider callbacks are authorized from server-owned task metadata and replay-protected nonces.
CREATE TABLE "ProviderResultAuthorization" (
    "id" UUID NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerTaskId" TEXT NOT NULL,
    "ownerId" UUID NOT NULL,
    "allowedHosts" JSONB NOT NULL,
    "expectedMimeType" TEXT NOT NULL,
    "expectedSizeBytes" BIGINT NOT NULL,
    "expectedChecksum" TEXT,
    "originalFileName" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'AWAITING_RESULT',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderResultAuthorization_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ProviderResultAuthorization_providerId_providerTaskId_key" ON "ProviderResultAuthorization"("providerId", "providerTaskId");
CREATE INDEX "ProviderResultAuthorization_status_expiresAt_idx" ON "ProviderResultAuthorization"("status", "expiresAt");

CREATE TABLE "ProviderCallbackNonce" (
    "providerId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ProviderCallbackNonce_pkey" PRIMARY KEY ("providerId", "nonce")
);
CREATE INDEX "ProviderCallbackNonce_expiresAt_idx" ON "ProviderCallbackNonce"("expiresAt");
