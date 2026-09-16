CREATE SCHEMA IF NOT EXISTS "public";

CREATE TYPE "PaymentOrderStatus" AS ENUM ('PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'FAILED');
CREATE TYPE "RefundStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "InvoiceStatus" AS ENUM ('APPLIED', 'APPROVED', 'ISSUED', 'REJECTED');
CREATE TYPE "ChannelReconciliationStatus" AS ENUM ('RUNNING', 'MATCHED', 'MISMATCHED', 'FAILED');

CREATE TABLE "RechargePackageSnapshot" (
  "id" UUID NOT NULL,
  "sourcePackageId" VARCHAR(80) NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "points" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RechargePackageSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentOrder" (
  "id" UUID NOT NULL,
  "orderNo" VARCHAR(64) NOT NULL,
  "userId" UUID NOT NULL,
  "packageSnapshotId" UUID NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "points" BIGINT NOT NULL,
  "currency" CHAR(3) NOT NULL,
  "description" VARCHAR(160) NOT NULL,
  "status" "PaymentOrderStatus" NOT NULL DEFAULT 'PENDING',
  "traceId" VARCHAR(64) NOT NULL,
  "prepayId" VARCHAR(160),
  "expiresAt" TIMESTAMPTZ(3),
  "transactionId" VARCHAR(80),
  "paidAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "PaymentOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PaymentCallback" (
  "id" UUID NOT NULL,
  "callbackId" VARCHAR(120) NOT NULL,
  "transactionId" VARCHAR(80) NOT NULL,
  "orderNo" VARCHAR(64) NOT NULL,
  "rawBodyHash" CHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "receivedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt" TIMESTAMPTZ(3),
  CONSTRAINT "PaymentCallback_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RefundOrder" (
  "id" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "refundNo" VARCHAR(64) NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "reason" VARCHAR(240) NOT NULL,
  "status" "RefundStatus" NOT NULL DEFAULT 'PENDING',
  "gatewayRefundId" VARCHAR(80),
  "walletBusinessKey" VARCHAR(120) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lastError" VARCHAR(500),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "RefundOrder_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceApplication" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "orderId" UUID NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "title" VARCHAR(160) NOT NULL,
  "taxNo" VARCHAR(40),
  "status" "InvoiceStatus" NOT NULL DEFAULT 'APPLIED',
  "rejectionReason" VARCHAR(240),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "issuedAt" TIMESTAMPTZ(3),
  CONSTRAINT "InvoiceApplication_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelReconciliation" (
  "id" UUID NOT NULL,
  "billDate" DATE NOT NULL,
  "status" "ChannelReconciliationStatus" NOT NULL DEFAULT 'RUNNING',
  "differenceCount" INTEGER NOT NULL DEFAULT 0,
  "summary" JSONB,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ChannelReconciliation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "OutboxEvent" (
  "id" UUID NOT NULL,
  "aggregateType" VARCHAR(80) NOT NULL,
  "aggregateId" VARCHAR(80) NOT NULL,
  "eventType" VARCHAR(120) NOT NULL,
  "payload" JSONB NOT NULL,
  "traceId" VARCHAR(64) NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedAt" TIMESTAMPTZ(3),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InboxMessage" (
  "messageId" VARCHAR(120) NOT NULL,
  "consumer" VARCHAR(120) NOT NULL,
  "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "result" JSONB,
  CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("messageId", "consumer")
);

CREATE UNIQUE INDEX "PaymentOrder_orderNo_key" ON "PaymentOrder"("orderNo");
CREATE UNIQUE INDEX "PaymentOrder_packageSnapshotId_key" ON "PaymentOrder"("packageSnapshotId");
CREATE UNIQUE INDEX "PaymentOrder_transactionId_key" ON "PaymentOrder"("transactionId");
CREATE INDEX "PaymentOrder_userId_createdAt_idx" ON "PaymentOrder"("userId", "createdAt");
CREATE INDEX "PaymentOrder_status_createdAt_idx" ON "PaymentOrder"("status", "createdAt");
CREATE UNIQUE INDEX "PaymentCallback_callbackId_key" ON "PaymentCallback"("callbackId");
CREATE UNIQUE INDEX "PaymentCallback_transactionId_key" ON "PaymentCallback"("transactionId");
CREATE INDEX "PaymentCallback_orderNo_receivedAt_idx" ON "PaymentCallback"("orderNo", "receivedAt");
CREATE UNIQUE INDEX "RefundOrder_refundNo_key" ON "RefundOrder"("refundNo");
CREATE UNIQUE INDEX "RefundOrder_gatewayRefundId_key" ON "RefundOrder"("gatewayRefundId");
CREATE UNIQUE INDEX "RefundOrder_walletBusinessKey_key" ON "RefundOrder"("walletBusinessKey");
CREATE INDEX "RefundOrder_status_createdAt_idx" ON "RefundOrder"("status", "createdAt");
CREATE UNIQUE INDEX "InvoiceApplication_orderId_key" ON "InvoiceApplication"("orderId");
CREATE INDEX "InvoiceApplication_userId_createdAt_idx" ON "InvoiceApplication"("userId", "createdAt");
CREATE INDEX "InvoiceApplication_status_createdAt_idx" ON "InvoiceApplication"("status", "createdAt");
CREATE UNIQUE INDEX "ChannelReconciliation_billDate_key" ON "ChannelReconciliation"("billDate");
CREATE INDEX "OutboxEvent_publishedAt_occurredAt_idx" ON "OutboxEvent"("publishedAt", "occurredAt");

ALTER TABLE "PaymentOrder" ADD CONSTRAINT "PaymentOrder_packageSnapshotId_fkey"
  FOREIGN KEY ("packageSnapshotId") REFERENCES "RechargePackageSnapshot"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RefundOrder" ADD CONSTRAINT "RefundOrder_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InvoiceApplication" ADD CONSTRAINT "InvoiceApplication_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "PaymentOrder"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "reject_payment_snapshot_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PAYMENT_FACTS_ARE_IMMUTABLE' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "RechargePackageSnapshot_immutable"
BEFORE UPDATE OR DELETE ON "RechargePackageSnapshot"
FOR EACH ROW EXECUTE FUNCTION "reject_payment_snapshot_mutation"();

CREATE FUNCTION "reject_payment_order_fact_mutation"() RETURNS trigger AS $$
BEGIN
  IF NEW."orderNo" IS DISTINCT FROM OLD."orderNo"
    OR NEW."userId" IS DISTINCT FROM OLD."userId"
    OR NEW."packageSnapshotId" IS DISTINCT FROM OLD."packageSnapshotId"
    OR NEW."amountMinor" IS DISTINCT FROM OLD."amountMinor"
    OR NEW."points" IS DISTINCT FROM OLD."points"
    OR NEW."currency" IS DISTINCT FROM OLD."currency" THEN
    RAISE EXCEPTION 'PAYMENT_FACTS_ARE_IMMUTABLE' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "PaymentOrder_facts_immutable"
BEFORE UPDATE ON "PaymentOrder"
FOR EACH ROW EXECUTE FUNCTION "reject_payment_order_fact_mutation"();
