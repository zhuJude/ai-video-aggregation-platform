ALTER TABLE "ProviderExecution"
  ADD COLUMN "callbackExpected" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "callbackDeadlineAt" TIMESTAMPTZ(3),
  ADD COLUMN "nextPollAt" TIMESTAMPTZ(3),
  ADD COLUMN "pollCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pollLeaseToken" CHAR(64),
  ADD COLUMN "pollLeaseExpiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "lastProviderSequence" INTEGER NOT NULL DEFAULT -1;

ALTER TABLE "CallbackInbox"
  ADD COLUMN "outcome" VARCHAR(40),
  ADD COLUMN "providerId" UUID;

UPDATE "CallbackInbox" AS callback
SET "providerId" = execution."providerId"
FROM "ProviderExecution" AS execution
WHERE callback."executionId" = execution."id";

ALTER TABLE "CallbackInbox"
  ALTER COLUMN "providerId" SET NOT NULL;

DROP INDEX "CallbackInbox_providerEventId_key";
DROP INDEX "CallbackInbox_executionId_providerEventId_key";
CREATE UNIQUE INDEX "CallbackInbox_providerId_providerEventId_key"
  ON "CallbackInbox"("providerId", "providerEventId");

ALTER TABLE "CircuitState"
  ADD COLUMN "halfOpenProbeToken" VARCHAR(160),
  ADD COLUMN "halfOpenProbeExpiresAt" TIMESTAMPTZ(3);

CREATE TABLE "CircuitObservation" (
  "id" UUID NOT NULL,
  "circuitId" UUID NOT NULL,
  "failed" BOOLEAN NOT NULL,
  "observedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "CircuitObservation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProviderExecution_status_nextPollAt_idx"
  ON "ProviderExecution"("status", "nextPollAt");
CREATE INDEX "CircuitObservation_circuitId_observedAt_idx"
  ON "CircuitObservation"("circuitId", "observedAt");
CREATE INDEX "CircuitObservation_observedAt_idx"
  ON "CircuitObservation"("observedAt");

ALTER TABLE "CircuitObservation"
  ADD CONSTRAINT "CircuitObservation_circuitId_fkey"
  FOREIGN KEY ("circuitId") REFERENCES "CircuitState"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
