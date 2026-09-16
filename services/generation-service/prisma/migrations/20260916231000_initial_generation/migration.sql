CREATE TYPE "TaskStatus" AS ENUM ('QUOTED', 'RESERVED', 'QUEUED', 'SUBMITTING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED', 'SETTLED', 'REFUNDED');
CREATE TYPE "RepairCaseStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'DISMISSED');
CREATE TYPE "TaskIdempotencyStatus" AS ENUM ('IN_PROGRESS', 'SUCCEEDED', 'FAILED');
CREATE TYPE "TaskCreationPhase" AS ENUM ('CLAIMED', 'RESERVE_REQUESTED', 'RESERVED', 'PERSISTENCE_FAILED', 'COMPENSATION_REQUESTED', 'COMPENSATED', 'REPAIR_REQUIRED', 'SUCCEEDED', 'FAILED');
CREATE TYPE "TaskTransitionSource" AS ENUM ('API', 'ORCHESTRATOR', 'WORKER', 'CALLBACK', 'POLLER', 'REPAIR');
CREATE TYPE "TaskTransitionActorType" AS ENUM ('USER', 'OPERATOR', 'SERVICE', 'PROVIDER');

CREATE TABLE "GenerationTask" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "quoteId" UUID NOT NULL,
    "capabilityVersionId" UUID NOT NULL,
    "status" "TaskStatus" NOT NULL DEFAULT 'QUOTED',
    "quoteSnapshot" JSONB NOT NULL,
    "quoteSnapshotSha256" CHAR(64) NOT NULL,
    "capabilitySnapshot" JSONB NOT NULL,
    "capabilitySnapshotSha256" CHAR(64) NOT NULL,
    "pricingSnapshot" JSONB NOT NULL,
    "pricingSnapshotSha256" CHAR(64) NOT NULL,
    "parametersSnapshot" JSONB NOT NULL,
    "parametersSnapshotSha256" CHAR(64) NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "GenerationTask_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskSaga" (
    "taskId" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "quotedPoints" VARCHAR(40) NOT NULL,
    "settlementPoints" VARCHAR(40) NOT NULL,
    "providerAccepted" BOOLEAN NOT NULL DEFAULT false,
    "providerStateRank" INTEGER NOT NULL DEFAULT 0,
    "providerId" UUID,
    "providerTaskId" VARCHAR(512),
    "modelCode" VARCHAR(160),
    "executionId" UUID,
    "routeEpoch" INTEGER NOT NULL DEFAULT 0,
    "assetImportRequested" BOOLEAN NOT NULL DEFAULT false,
    "assetImportDispatched" BOOLEAN NOT NULL DEFAULT false,
    "assetId" UUID,
    "routingFailoverAuthorized" BOOLEAN NOT NULL DEFAULT false,
    "cancellationChargePoints" VARCHAR(40),
    "cancelRequested" BOOLEAN NOT NULL DEFAULT false,
    "financialDisposition" VARCHAR(80),
    "financialSettlementKey" VARCHAR(120),
    "financialReleaseKey" VARCHAR(120),
    "substitute" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TaskSaga_pkey" PRIMARY KEY ("taskId")
);

CREATE TABLE "TaskTransition" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "fromStatus" "TaskStatus" NOT NULL,
    "toStatus" "TaskStatus" NOT NULL,
    "taskVersion" INTEGER NOT NULL,
    "reasonCode" VARCHAR(80) NOT NULL,
    "source" "TaskTransitionSource" NOT NULL,
    "actorType" "TaskTransitionActorType" NOT NULL,
    "actorId" VARCHAR(160) NOT NULL,
    "traceId" CHAR(32) NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TaskTransition_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskIdempotency" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "requestSha256" CHAR(64) NOT NULL,
    "proposedTaskId" UUID NOT NULL,
    "quotedPoints" VARCHAR(40) NOT NULL,
    "reserveBusinessKey" VARCHAR(120) NOT NULL,
    "compensationBusinessKey" VARCHAR(120) NOT NULL,
    "traceId" CHAR(32) NOT NULL,
    "leaseToken" CHAR(64) NOT NULL,
    "phase" "TaskCreationPhase" NOT NULL DEFAULT 'CLAIMED',
    "status" "TaskIdempotencyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "response" JSONB,
    "taskId" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "TaskIdempotency_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "aggregateType" VARCHAR(80) NOT NULL,
    "aggregateId" UUID NOT NULL,
    "eventType" VARCHAR(160) NOT NULL,
    "eventVersion" INTEGER NOT NULL,
    "deduplicationKey" VARCHAR(240),
    "payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "availableAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboxMessage" (
    "id" UUID NOT NULL,
    "consumer" VARCHAR(120) NOT NULL,
    "messageId" VARCHAR(160) NOT NULL,
    "eventType" VARCHAR(160) NOT NULL,
    "payloadSha256" CHAR(64) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    "leaseToken" CHAR(64),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TaskRepairCase" (
    "id" UUID NOT NULL,
    "taskId" UUID,
    "idempotencyId" UUID,
    "status" "RepairCaseStatus" NOT NULL DEFAULT 'OPEN',
    "kind" VARCHAR(80) NOT NULL,
    "summary" VARCHAR(500) NOT NULL,
    "evidence" JSONB NOT NULL,
    "detectedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" JSONB,
    "deduplicationKey" VARCHAR(240),
    CONSTRAINT "TaskRepairCase_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "GenerationTask_quoteId_key" ON "GenerationTask"("quoteId");
CREATE INDEX "GenerationTask_userId_createdAt_id_idx" ON "GenerationTask"("userId", "createdAt", "id");
CREATE INDEX "GenerationTask_status_updatedAt_idx" ON "GenerationTask"("status", "updatedAt");
CREATE INDEX "GenerationTask_capabilityVersionId_createdAt_idx" ON "GenerationTask"("capabilityVersionId", "createdAt");
CREATE INDEX "TaskSaga_providerId_providerTaskId_idx" ON "TaskSaga"("providerId", "providerTaskId");
CREATE INDEX "TaskSaga_updatedAt_idx" ON "TaskSaga"("updatedAt");
CREATE INDEX "TaskTransition_taskId_createdAt_idx" ON "TaskTransition"("taskId", "createdAt");
CREATE INDEX "TaskTransition_toStatus_createdAt_idx" ON "TaskTransition"("toStatus", "createdAt");
CREATE INDEX "TaskTransition_traceId_idx" ON "TaskTransition"("traceId");
CREATE INDEX "TaskTransition_source_createdAt_idx" ON "TaskTransition"("source", "createdAt");
CREATE UNIQUE INDEX "TaskTransition_taskId_taskVersion_key" ON "TaskTransition"("taskId", "taskVersion");
CREATE UNIQUE INDEX "TaskIdempotency_leaseToken_key" ON "TaskIdempotency"("leaseToken");
CREATE INDEX "TaskIdempotency_taskId_idx" ON "TaskIdempotency"("taskId");
CREATE INDEX "TaskIdempotency_expiresAt_idx" ON "TaskIdempotency"("expiresAt");
CREATE UNIQUE INDEX "TaskIdempotency_userId_idempotencyKey_key" ON "TaskIdempotency"("userId", "idempotencyKey");
CREATE UNIQUE INDEX "OutboxEvent_deduplicationKey_key" ON "OutboxEvent"("deduplicationKey");
CREATE INDEX "OutboxEvent_publishedAt_availableAt_idx" ON "OutboxEvent"("publishedAt", "availableAt");
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_occurredAt_idx" ON "OutboxEvent"("aggregateType", "aggregateId", "occurredAt");
CREATE INDEX "InboxMessage_consumer_processedAt_receivedAt_idx" ON "InboxMessage"("consumer", "processedAt", "receivedAt");
CREATE UNIQUE INDEX "InboxMessage_consumer_messageId_key" ON "InboxMessage"("consumer", "messageId");
CREATE UNIQUE INDEX "TaskRepairCase_idempotencyId_key" ON "TaskRepairCase"("idempotencyId");
CREATE UNIQUE INDEX "TaskRepairCase_deduplicationKey_key" ON "TaskRepairCase"("deduplicationKey");
CREATE INDEX "TaskRepairCase_status_detectedAt_idx" ON "TaskRepairCase"("status", "detectedAt");
CREATE INDEX "TaskRepairCase_taskId_detectedAt_idx" ON "TaskRepairCase"("taskId", "detectedAt");
CREATE INDEX "TaskRepairCase_idempotencyId_detectedAt_idx" ON "TaskRepairCase"("idempotencyId", "detectedAt");

ALTER TABLE "TaskSaga" ADD CONSTRAINT "TaskSaga_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GenerationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskTransition" ADD CONSTRAINT "TaskTransition_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GenerationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskIdempotency" ADD CONSTRAINT "TaskIdempotency_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GenerationTask"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "TaskRepairCase" ADD CONSTRAINT "TaskRepairCase_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "GenerationTask"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TaskRepairCase" ADD CONSTRAINT "TaskRepairCase_idempotencyId_fkey" FOREIGN KEY ("idempotencyId") REFERENCES "TaskIdempotency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
