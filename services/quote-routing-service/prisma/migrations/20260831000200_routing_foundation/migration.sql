CREATE TYPE "RuleStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');
CREATE TYPE "QuoteMode" AS ENUM ('SMART', 'PROFESSIONAL');

CREATE TABLE "CostRuleVersion" (
  "id" UUID PRIMARY KEY,
  "modelId" UUID NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
  "basePoints" BIGINT NOT NULL CHECK ("basePoints" >= 0),
  "unitPoints" BIGINT NOT NULL CHECK ("unitPoints" >= 0),
  "costDimension" TEXT,
  "configuration" JSONB NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  "publishedBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CostRuleVersion_modelId_version_key" UNIQUE ("modelId", "version")
);
CREATE INDEX "CostRuleVersion_modelId_status_effectiveAt_idx"
  ON "CostRuleVersion"("modelId", "status", "effectiveAt");

CREATE TABLE "SalePriceRuleVersion" (
  "id" UUID PRIMARY KEY,
  "modelId" UUID NOT NULL,
  "version" INTEGER NOT NULL CHECK ("version" > 0),
  "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
  "ruleType" TEXT NOT NULL,
  "fixedPoints" BIGINT CHECK ("fixedPoints" >= 0),
  "marginBasisPoints" INTEGER CHECK ("marginBasisPoints" >= 0),
  "configuration" JSONB NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  "publishedBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalePriceRuleVersion_modelId_version_key" UNIQUE ("modelId", "version")
);
CREATE INDEX "SalePriceRuleVersion_modelId_status_effectiveAt_idx"
  ON "SalePriceRuleVersion"("modelId", "status", "effectiveAt");

CREATE TABLE "RoutePolicyVersion" (
  "id" UUID PRIMARY KEY,
  "version" INTEGER NOT NULL UNIQUE CHECK ("version" > 0),
  "status" "RuleStatus" NOT NULL DEFAULT 'DRAFT',
  "qualityWeight" INTEGER NOT NULL CHECK ("qualityWeight" >= 0),
  "speedWeight" INTEGER NOT NULL CHECK ("speedWeight" >= 0),
  "priceWeight" INTEGER NOT NULL CHECK ("priceWeight" >= 0),
  "minimumMarginBasisPoints" INTEGER NOT NULL CHECK ("minimumMarginBasisPoints" >= 0),
  "configuration" JSONB NOT NULL,
  "effectiveAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3),
  "publishedBy" UUID,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "RoutePolicyVersion_status_effectiveAt_idx"
  ON "RoutePolicyVersion"("status", "effectiveAt");

CREATE TABLE "Quote" (
  "id" UUID PRIMARY KEY,
  "userId" UUID NOT NULL,
  "mode" "QuoteMode" NOT NULL,
  "modelId" UUID,
  "candidateModelIds" UUID[] NOT NULL,
  "capabilityVersionId" UUID NOT NULL,
  "quotedPoints" BIGINT NOT NULL CHECK ("quotedPoints" >= 0),
  "costEstimatePoints" BIGINT NOT NULL CHECK ("costEstimatePoints" >= 0),
  "pricingRuleVersion" INTEGER NOT NULL CHECK ("pricingRuleVersion" > 0),
  "routingRuleVersion" INTEGER NOT NULL CHECK ("routingRuleVersion" > 0),
  "parametersHash" CHAR(64) NOT NULL CHECK ("parametersHash" ~ '^[a-f0-9]{64}$'),
  "parametersSnapshot" JSONB NOT NULL,
  "allowFailover" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Quote_expiry_check" CHECK ("expiresAt" > "createdAt")
);
CREATE INDEX "Quote_userId_createdAt_idx" ON "Quote"("userId", "createdAt");
CREATE INDEX "Quote_expiresAt_idx" ON "Quote"("expiresAt");

CREATE TABLE "RouteDecision" (
  "id" UUID PRIMARY KEY,
  "quoteId" UUID UNIQUE REFERENCES "Quote"("id") ON DELETE RESTRICT,
  "selectedModelId" UUID NOT NULL,
  "candidateSnapshot" JSONB NOT NULL,
  "explanation" JSONB NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL
);
CREATE INDEX "RouteDecision_selectedModelId_createdAt_idx"
  ON "RouteDecision"("selectedModelId", "createdAt");

CREATE TABLE "OutboxEvent" (
  "id" UUID PRIMARY KEY,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" UUID NOT NULL,
  "eventType" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "occurredAt" TIMESTAMPTZ(3) NOT NULL,
  "publishedAt" TIMESTAMPTZ(3)
);
CREATE INDEX "OutboxEvent_publishedAt_occurredAt_idx" ON "OutboxEvent"("publishedAt", "occurredAt");

CREATE FUNCTION prevent_published_rule_mutation() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('PUBLISHED', 'RETIRED') THEN
    RAISE EXCEPTION 'RULE_VERSION_IMMUTABLE' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "CostRuleVersion_immutable_after_publication"
BEFORE UPDATE OR DELETE ON "CostRuleVersion"
FOR EACH ROW EXECUTE FUNCTION prevent_published_rule_mutation();
CREATE TRIGGER "SalePriceRuleVersion_immutable_after_publication"
BEFORE UPDATE OR DELETE ON "SalePriceRuleVersion"
FOR EACH ROW EXECUTE FUNCTION prevent_published_rule_mutation();
CREATE TRIGGER "RoutePolicyVersion_immutable_after_publication"
BEFORE UPDATE OR DELETE ON "RoutePolicyVersion"
FOR EACH ROW EXECUTE FUNCTION prevent_published_rule_mutation();
