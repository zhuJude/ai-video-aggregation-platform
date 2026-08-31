-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('UPLOAD', 'RESULT', 'THUMBNAIL');

-- CreateEnum
CREATE TYPE "AssetStatus" AS ENUM ('PENDING', 'AVAILABLE', 'DELETING', 'DELETED');

-- CreateEnum
CREATE TYPE "UploadSessionStatus" AS ENUM ('PENDING', 'COMPLETED', 'EXPIRED', 'REJECTED');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

-- CreateTable
CREATE TABLE "Asset" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "status" "AssetStatus" NOT NULL DEFAULT 'PENDING',
    "objectKey" TEXT NOT NULL,
    "originalFileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "checksum" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "availableAt" TIMESTAMPTZ(3),
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UploadSession" (
    "id" UUID NOT NULL,
    "ownerId" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "expectedMimeType" TEXT NOT NULL,
    "expectedSizeBytes" BIGINT NOT NULL,
    "status" "UploadSessionStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetDeletion" (
    "id" UUID NOT NULL,
    "assetId" UUID NOT NULL,
    "objectKey" TEXT NOT NULL,
    "scheduledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "AssetDeletion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_objectKey_key" ON "Asset"("objectKey");
CREATE INDEX "Asset_ownerId_status_createdAt_idx" ON "Asset"("ownerId", "status", "createdAt");
CREATE UNIQUE INDEX "UploadSession_assetId_key" ON "UploadSession"("assetId");
CREATE UNIQUE INDEX "UploadSession_objectKey_key" ON "UploadSession"("objectKey");
CREATE INDEX "UploadSession_ownerId_status_expiresAt_idx" ON "UploadSession"("ownerId", "status", "expiresAt");
CREATE INDEX "UploadSession_status_expiresAt_idx" ON "UploadSession"("status", "expiresAt");
CREATE INDEX "AssetDeletion_deletedAt_scheduledAt_idx" ON "AssetDeletion"("deletedAt", "scheduledAt");
CREATE INDEX "OutboxEvent_status_occurredAt_idx" ON "OutboxEvent"("status", "occurredAt");
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_idx" ON "OutboxEvent"("aggregateType", "aggregateId");

-- AddForeignKey
ALTER TABLE "UploadSession" ADD CONSTRAINT "UploadSession_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssetDeletion" ADD CONSTRAINT "AssetDeletion_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
