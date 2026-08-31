CREATE TABLE "InboxMessage" (
  "messageId" TEXT PRIMARY KEY,
  "eventType" TEXT NOT NULL,
  "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE "ProviderHealthSnapshot" (
  "providerId" UUID PRIMARY KEY,
  "sequence" BIGINT NOT NULL CHECK ("sequence" > 0),
  "health" TEXT NOT NULL CHECK ("health" IN ('HEALTHY', 'DEGRADED', 'UNHEALTHY')),
  "balanceLow" BOOLEAN NOT NULL,
  "quotaExhausted" BOOLEAN NOT NULL,
  "circuitOpen" BOOLEAN NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL
);
