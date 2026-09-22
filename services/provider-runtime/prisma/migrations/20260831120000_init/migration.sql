CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "ProviderExecutionStatus" AS ENUM ('SUBMITTING', 'ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'RETRY_SCHEDULED', 'AMBIGUOUS');
CREATE TYPE "ProviderAttemptAction" AS ENUM ('CREATE', 'QUERY', 'CANCEL');
CREATE TYPE "ProviderAttemptStatus" AS ENUM ('STARTED', 'ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'RETRY_SCHEDULED', 'AMBIGUOUS');
CREATE TYPE "ProviderNextAction" AS ENUM ('NONE', 'CREATE_RETRY', 'RECONCILE', 'POLL');
CREATE TYPE "CircuitStatus" AS ENUM ('CLOSED', 'OPEN', 'HALF_OPEN');

CREATE TABLE "ProviderExecution" (
    "id" UUID NOT NULL,
    "taskId" UUID NOT NULL,
    "capabilityVersionId" UUID NOT NULL,
    "parametersSnapshotSha256" CHAR(64) NOT NULL,
    "providerId" UUID NOT NULL,
    "modelCode" VARCHAR(160) NOT NULL,
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "providerTaskId" VARCHAR(512),
    "status" "ProviderExecutionStatus" NOT NULL DEFAULT 'SUBMITTING',
    "currentAttempt" INTEGER NOT NULL DEFAULT 1,
    "nextAction" "ProviderNextAction" NOT NULL DEFAULT 'NONE',
    "nextAttemptAt" TIMESTAMPTZ(3),
    "lastErrorCode" VARCHAR(120),
    "lastHttpStatus" INTEGER,
    "traceId" CHAR(32) NOT NULL,
    "correlationId" UUID NOT NULL,
    "leaseToken" CHAR(64),
    "leaseExpiresAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "ProviderExecution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderAttempt" (
    "id" UUID NOT NULL,
    "executionId" UUID NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "action" "ProviderAttemptAction" NOT NULL,
    "status" "ProviderAttemptStatus" NOT NULL DEFAULT 'STARTED',
    "idempotencyKey" VARCHAR(160) NOT NULL,
    "providerTaskId" VARCHAR(512),
    "httpStatus" INTEGER,
    "errorCode" VARCHAR(120),
    "leaseToken" CHAR(64),
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "completedAt" TIMESTAMPTZ(3),
    CONSTRAINT "ProviderAttempt_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboxMessage" (
    "id" UUID NOT NULL,
    "consumer" VARCHAR(160) NOT NULL,
    "messageId" VARCHAR(160) NOT NULL,
    "eventType" VARCHAR(160) NOT NULL,
    "payloadSha256" CHAR(64) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "processedAt" TIMESTAMPTZ(3),
    "lastError" TEXT,
    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CallbackInbox" (
    "id" UUID NOT NULL,
    "providerEventId" VARCHAR(256) NOT NULL,
    "executionId" UUID NOT NULL,
    "providerTaskId" VARCHAR(512) NOT NULL,
    "sequence" INTEGER NOT NULL,
    "payloadSha256" CHAR(64) NOT NULL,
    "receivedAt" TIMESTAMPTZ(3) NOT NULL,
    "processedAt" TIMESTAMPTZ(3),
    CONSTRAINT "CallbackInbox_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CircuitState" (
    "id" UUID NOT NULL,
    "providerId" UUID NOT NULL,
    "modelCode" VARCHAR(160) NOT NULL,
    "status" "CircuitStatus" NOT NULL DEFAULT 'CLOSED',
    "windowStartedAt" TIMESTAMPTZ(3),
    "windowRequests" INTEGER NOT NULL DEFAULT 0,
    "windowFailures" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMPTZ(3),
    "openUntil" TIMESTAMPTZ(3),
    "halfOpenProbeInFlight" BOOLEAN NOT NULL DEFAULT false,
    "reasonCode" VARCHAR(120),
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "CircuitState_pkey" PRIMARY KEY ("id")
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
    "availableAt" TIMESTAMPTZ(3) NOT NULL,
    "publishedAt" TIMESTAMPTZ(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ProviderExecution_taskId_key" ON "ProviderExecution"("taskId");
CREATE INDEX "ProviderExecution_status_nextAttemptAt_idx" ON "ProviderExecution"("status", "nextAttemptAt");
CREATE INDEX "ProviderExecution_providerId_modelCode_status_idx" ON "ProviderExecution"("providerId", "modelCode", "status");
CREATE INDEX "ProviderExecution_providerTaskId_idx" ON "ProviderExecution"("providerTaskId");
CREATE INDEX "ProviderExecution_updatedAt_idx" ON "ProviderExecution"("updatedAt");
CREATE UNIQUE INDEX "ProviderExecution_providerId_providerTaskId_key" ON "ProviderExecution"("providerId", "providerTaskId");
CREATE INDEX "ProviderAttempt_status_startedAt_idx" ON "ProviderAttempt"("status", "startedAt");
CREATE INDEX "ProviderAttempt_providerTaskId_idx" ON "ProviderAttempt"("providerTaskId");
CREATE UNIQUE INDEX "ProviderAttempt_executionId_attemptNumber_key" ON "ProviderAttempt"("executionId", "attemptNumber");
CREATE INDEX "InboxMessage_consumer_processedAt_receivedAt_idx" ON "InboxMessage"("consumer", "processedAt", "receivedAt");
CREATE UNIQUE INDEX "InboxMessage_consumer_messageId_key" ON "InboxMessage"("consumer", "messageId");
CREATE UNIQUE INDEX "CallbackInbox_providerEventId_key" ON "CallbackInbox"("providerEventId");
CREATE INDEX "CallbackInbox_executionId_sequence_idx" ON "CallbackInbox"("executionId", "sequence");
CREATE INDEX "CallbackInbox_providerTaskId_sequence_idx" ON "CallbackInbox"("providerTaskId", "sequence");
CREATE INDEX "CallbackInbox_processedAt_receivedAt_idx" ON "CallbackInbox"("processedAt", "receivedAt");
CREATE UNIQUE INDEX "CallbackInbox_executionId_providerEventId_key" ON "CallbackInbox"("executionId", "providerEventId");
CREATE INDEX "CircuitState_status_openUntil_idx" ON "CircuitState"("status", "openUntil");
CREATE UNIQUE INDEX "CircuitState_providerId_modelCode_key" ON "CircuitState"("providerId", "modelCode");
CREATE UNIQUE INDEX "OutboxEvent_deduplicationKey_key" ON "OutboxEvent"("deduplicationKey");
CREATE INDEX "OutboxEvent_publishedAt_availableAt_idx" ON "OutboxEvent"("publishedAt", "availableAt");
CREATE INDEX "OutboxEvent_aggregateType_aggregateId_occurredAt_idx" ON "OutboxEvent"("aggregateType", "aggregateId", "occurredAt");

ALTER TABLE "ProviderAttempt" ADD CONSTRAINT "ProviderAttempt_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ProviderExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallbackInbox" ADD CONSTRAINT "CallbackInbox_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "ProviderExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;
