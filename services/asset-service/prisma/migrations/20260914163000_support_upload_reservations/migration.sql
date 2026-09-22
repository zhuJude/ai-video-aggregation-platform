CREATE TABLE "SupportUploadReservation" (
  "id" UUID NOT NULL,
  "operationId" TEXT NOT NULL,
  "remoteOperationId" TEXT NOT NULL,
  "generation" INTEGER NOT NULL,
  "fence" TEXT NOT NULL,
  "requestHash" TEXT NOT NULL,
  "idempotencyKey" TEXT NOT NULL,
  "ownershipToken" TEXT NOT NULL,
  "sessionId" UUID NOT NULL,
  "assetId" UUID NOT NULL,
  "ownerId" UUID NOT NULL,
  "purpose" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupportUploadReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupportUploadReservation_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "UploadSession"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "SupportUploadReservation_remoteOperationId_key" ON "SupportUploadReservation"("remoteOperationId");
CREATE UNIQUE INDEX "SupportUploadReservation_operationId_generation_key" ON "SupportUploadReservation"("operationId", "generation");
CREATE INDEX "SupportUploadReservation_status_expiresAt_idx" ON "SupportUploadReservation"("status", "expiresAt");
