ALTER TABLE "RefundOrder" ADD COLUMN "traceId" VARCHAR(64);
UPDATE "RefundOrder" SET "traceId" = 'migration:' || "id"::text WHERE "traceId" IS NULL;
ALTER TABLE "RefundOrder" ALTER COLUMN "traceId" SET NOT NULL;
