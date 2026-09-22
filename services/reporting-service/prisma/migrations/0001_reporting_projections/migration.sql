CREATE TABLE "ProjectionVersion" (
  "version" INTEGER PRIMARY KEY,
  "status" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT FALSE,
  "sourceCount" BIGINT NOT NULL DEFAULT 0,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  "failureReason" TEXT
);

CREATE UNIQUE INDEX "ProjectionVersion_one_active_idx"
  ON "ProjectionVersion" ("active") WHERE "active" = TRUE;

CREATE TABLE "ProcessedEvent" (
  "eventId" UUID NOT NULL,
  "projectionVersion" INTEGER NOT NULL,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "contribution" JSONB NOT NULL,
  PRIMARY KEY ("eventId", "projectionVersion")
);
CREATE INDEX "ProcessedEvent_version_occurred_idx"
  ON "ProcessedEvent" ("projectionVersion", "occurredAt");

CREATE TABLE "ProjectionContribution" (
  "sourceEventId" UUID NOT NULL,
  "projectionVersion" INTEGER NOT NULL,
  "reversedByEventId" UUID,
  "contribution" JSONB NOT NULL,
  PRIMARY KEY ("sourceEventId", "projectionVersion")
);
CREATE UNIQUE INDEX "ProjectionContribution_reversal_idx"
  ON "ProjectionContribution" ("reversedByEventId", "projectionVersion")
  WHERE "reversedByEventId" IS NOT NULL;

CREATE TABLE "DailyBusinessMetric" (
  "businessDate" DATE NOT NULL,
  "projectionVersion" INTEGER NOT NULL,
  "rechargePoints" BIGINT NOT NULL DEFAULT 0,
  "rechargeAmountMinor" BIGINT NOT NULL DEFAULT 0,
  "consumedPoints" BIGINT NOT NULL DEFAULT 0,
  "revenueMinor" BIGINT NOT NULL DEFAULT 0,
  "providerCostMinor" BIGINT NOT NULL DEFAULT 0,
  "marginNumeratorMinor" BIGINT NOT NULL DEFAULT 0,
  "marginDenominatorMinor" BIGINT NOT NULL DEFAULT 0,
  "successfulTasks" BIGINT NOT NULL DEFAULT 0,
  "failedTasks" BIGINT NOT NULL DEFAULT 0,
  "taskDurationMsTotal" BIGINT NOT NULL DEFAULT 0,
  "taskDurationSamples" BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY ("businessDate", "projectionVersion")
);

CREATE TABLE "ProviderDailyMetric" (
  "businessDate" DATE NOT NULL,
  "providerId" UUID NOT NULL,
  "projectionVersion" INTEGER NOT NULL,
  "successfulTasks" BIGINT NOT NULL DEFAULT 0,
  "failedTasks" BIGINT NOT NULL DEFAULT 0,
  "providerCostMinor" BIGINT NOT NULL DEFAULT 0,
  "durationMsTotal" BIGINT NOT NULL DEFAULT 0,
  "durationSamples" BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY ("businessDate", "providerId", "projectionVersion")
);

CREATE TABLE "ModelDailyMetric" (
  "businessDate" DATE NOT NULL,
  "modelId" UUID NOT NULL,
  "projectionVersion" INTEGER NOT NULL,
  "successfulTasks" BIGINT NOT NULL DEFAULT 0,
  "failedTasks" BIGINT NOT NULL DEFAULT 0,
  "consumedPoints" BIGINT NOT NULL DEFAULT 0,
  "revenueMinor" BIGINT NOT NULL DEFAULT 0,
  "providerCostMinor" BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY ("businessDate", "modelId", "projectionVersion")
);

CREATE TABLE "UserSegmentMetric" (
  "businessDate" DATE NOT NULL,
  "segment" TEXT NOT NULL,
  "projectionVersion" INTEGER NOT NULL,
  "acquiredUsers" BIGINT NOT NULL DEFAULT 0,
  "activeUsers" BIGINT NOT NULL DEFAULT 0,
  "retainedUsers" BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY ("businessDate", "segment", "projectionVersion")
);

CREATE TABLE "RealtimeCounter" (
  "key" TEXT NOT NULL,
  "projectionVersion" INTEGER NOT NULL,
  "value" BIGINT NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("key", "projectionVersion")
);

CREATE TABLE "ProjectionCheckpoint" (
  "consumer" TEXT NOT NULL,
  "projectionVersion" INTEGER NOT NULL,
  "eventId" UUID NOT NULL,
  "projectedThrough" TIMESTAMPTZ(3) NOT NULL,
  "processedAt" TIMESTAMPTZ(3) NOT NULL,
  PRIMARY KEY ("consumer", "projectionVersion")
);

INSERT INTO "ProjectionVersion" (
  "version", "status", "active", "sourceCount", "startedAt", "completedAt"
) VALUES (1, 'SUCCEEDED', TRUE, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
