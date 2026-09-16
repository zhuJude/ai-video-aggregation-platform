-- CreateEnum
CREATE TYPE "AdjustmentDirection" AS ENUM ('CREDIT', 'DEBIT');

-- CreateEnum
CREATE TYPE "AdjustmentStatus" AS ENUM ('PENDING', 'POSTED', 'REJECTED');

-- CreateTable
CREATE TABLE "ReconciliationMismatch" (
    "id" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "userId" VARCHAR(80) NOT NULL,
    "account" "WalletAccountKind" NOT NULL,
    "expected" BIGINT NOT NULL,
    "actual" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReconciliationMismatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletRestriction" (
    "userId" VARCHAR(80) NOT NULL,
    "reconciliationRunId" UUID NOT NULL,
    "reason" VARCHAR(120) NOT NULL,
    "blockedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unblockedAt" TIMESTAMPTZ(3),
    CONSTRAINT "WalletRestriction_pkey" PRIMARY KEY ("userId")
);

-- CreateTable
CREATE TABLE "AdjustmentRequest" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "direction" "AdjustmentDirection" NOT NULL,
    "points" BIGINT NOT NULL,
    "requestedBy" VARCHAR(80) NOT NULL,
    "reason" VARCHAR(240) NOT NULL,
    "traceId" VARCHAR(64) NOT NULL,
    "status" "AdjustmentStatus" NOT NULL DEFAULT 'PENDING',
    "postedTransactionId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    CONSTRAINT "AdjustmentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdjustmentApproval" (
    "requestId" UUID NOT NULL,
    "adminId" VARCHAR(80) NOT NULL,
    "approvedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AdjustmentApproval_pkey" PRIMARY KEY ("requestId", "adminId")
);

CREATE INDEX "ReconciliationMismatch_runId_idx" ON "ReconciliationMismatch"("runId");
CREATE INDEX "ReconciliationMismatch_userId_createdAt_idx" ON "ReconciliationMismatch"("userId", "createdAt");
CREATE INDEX "AdjustmentRequest_userId_createdAt_idx" ON "AdjustmentRequest"("userId", "createdAt");
CREATE INDEX "AdjustmentRequest_status_createdAt_idx" ON "AdjustmentRequest"("status", "createdAt");

ALTER TABLE "ReconciliationMismatch" ADD CONSTRAINT "ReconciliationMismatch_runId_fkey" FOREIGN KEY ("runId") REFERENCES "ReconciliationRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdjustmentApproval" ADD CONSTRAINT "AdjustmentApproval_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "AdjustmentRequest"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
