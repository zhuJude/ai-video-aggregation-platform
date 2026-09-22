DROP INDEX IF EXISTS "ProviderExecution_taskId_key";

ALTER TABLE "ProviderExecution"
ADD COLUMN "routeEpoch" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "ProviderExecution_taskId_routeEpoch_key"
ON "ProviderExecution"("taskId", "routeEpoch");
