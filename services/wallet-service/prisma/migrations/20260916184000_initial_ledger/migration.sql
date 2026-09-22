-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "WalletAccountKind" AS ENUM ('USER_AVAILABLE', 'USER_FROZEN', 'PLATFORM_LIABILITY', 'PLATFORM_CONSUMED', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerTransactionKind" AS ENUM ('CREDIT', 'RESERVE', 'SETTLE', 'RELEASE', 'ADJUST', 'REPAIR', 'REFUND');

-- CreateEnum
CREATE TYPE "ReconciliationStatus" AS ENUM ('RUNNING', 'MATCHED', 'MISMATCHED', 'REPAIRED');

-- CreateTable
CREATE TABLE "WalletAccount" (
    "id" UUID NOT NULL,
    "ownerId" VARCHAR(80) NOT NULL,
    "kind" "WalletAccountKind" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WalletAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerTransaction" (
    "id" UUID NOT NULL,
    "businessKey" VARCHAR(120) NOT NULL,
    "commandFingerprint" VARCHAR(320) NOT NULL,
    "kind" "LedgerTransactionKind" NOT NULL,
    "userId" UUID,
    "points" BIGINT NOT NULL,
    "reason" VARCHAR(240),
    "traceId" VARCHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" UUID NOT NULL,
    "transactionId" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "delta" BIGINT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BalanceSnapshot" (
    "accountId" UUID NOT NULL,
    "balance" BIGINT NOT NULL,
    "version" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "BalanceSnapshot_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
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

-- CreateTable
CREATE TABLE "InboxMessage" (
    "messageId" VARCHAR(120) NOT NULL,
    "consumer" VARCHAR(120) NOT NULL,
    "processedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "result" JSONB,
    CONSTRAINT "InboxMessage_pkey" PRIMARY KEY ("messageId", "consumer")
);

-- CreateTable
CREATE TABLE "ReconciliationRun" (
    "id" UUID NOT NULL,
    "status" "ReconciliationStatus" NOT NULL,
    "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ(3),
    "mismatchCount" INTEGER NOT NULL DEFAULT 0,
    "summary" JSONB,
    CONSTRAINT "ReconciliationRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "WalletAccount_ownerId_idx" ON "WalletAccount"("ownerId");
CREATE UNIQUE INDEX "WalletAccount_ownerId_kind_key" ON "WalletAccount"("ownerId", "kind");
CREATE UNIQUE INDEX "LedgerTransaction_businessKey_key" ON "LedgerTransaction"("businessKey");
CREATE INDEX "LedgerTransaction_userId_createdAt_idx" ON "LedgerTransaction"("userId", "createdAt");
CREATE INDEX "LedgerEntry_transactionId_idx" ON "LedgerEntry"("transactionId");
CREATE INDEX "LedgerEntry_accountId_createdAt_idx" ON "LedgerEntry"("accountId", "createdAt");
CREATE INDEX "OutboxEvent_publishedAt_occurredAt_idx" ON "OutboxEvent"("publishedAt", "occurredAt");

ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "LedgerTransaction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BalanceSnapshot" ADD CONSTRAINT "BalanceSnapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WalletAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Ledger facts are append-only. Corrections must be compensating transactions.
CREATE FUNCTION "reject_ledger_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'LEDGER_FACTS_ARE_IMMUTABLE' USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "LedgerTransaction_immutable"
BEFORE UPDATE OR DELETE ON "LedgerTransaction"
FOR EACH ROW EXECUTE FUNCTION "reject_ledger_mutation"();

CREATE TRIGGER "LedgerEntry_immutable"
BEFORE UPDATE OR DELETE ON "LedgerEntry"
FOR EACH ROW EXECUTE FUNCTION "reject_ledger_mutation"();
