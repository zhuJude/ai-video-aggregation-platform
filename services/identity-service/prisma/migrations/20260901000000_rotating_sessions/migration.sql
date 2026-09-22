-- Refresh-token families make reuse detection durable and allow family-wide revocation.
-- Construct RFC 9562 UUIDv7 values: 48-bit Unix milliseconds, version 7,
-- RFC variant bits, and cryptographically secure entropy from gen_random_uuid().
CREATE OR REPLACE FUNCTION identity_uuid_v7() RETURNS UUID
LANGUAGE SQL VOLATILE PARALLEL SAFE
AS $$
SELECT (
    lpad(to_hex(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0') ||
    '7' || substr(replace(gen_random_uuid()::text, '-', ''), 2, 3) ||
    '8' || substr(replace(gen_random_uuid()::text, '-', ''), 2, 3) ||
    substr(replace(gen_random_uuid()::text, '-', ''), 2, 12)
)::uuid;
$$;

ALTER TABLE "sessions" ADD COLUMN "family_id" UUID DEFAULT identity_uuid_v7();
UPDATE "sessions"
SET "family_id" = identity_uuid_v7()
WHERE "family_id" IS NULL;
ALTER TABLE "sessions" ALTER COLUMN "family_id" SET NOT NULL;
ALTER TABLE "sessions" ALTER COLUMN "family_id" SET DEFAULT identity_uuid_v7();
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_family_id_uuid_v7_check"
CHECK (substring("family_id"::text FROM 15 FOR 1) = '7');
ALTER TABLE "sessions" ADD COLUMN "consumed_at" TIMESTAMP(3);

CREATE INDEX "sessions_family_id_revoked_at_idx" ON "sessions"("family_id", "revoked_at");

-- The transactional outbox keeps identity lifecycle changes atomic with user/session writes.
CREATE TABLE "outbox_events" (
    "id" UUID NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "trace_id" CHAR(32) NOT NULL,
    "correlation_id" UUID NOT NULL,
    "causation_id" UUID,
    "producer" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),

    CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbox_events_dedupe_key_key" ON "outbox_events"("dedupe_key");
CREATE INDEX "outbox_events_published_at_occurred_at_idx"
ON "outbox_events"("published_at", "occurred_at");

ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_id_uuid_v7_check"
CHECK (substring("id"::text FROM 15 FOR 1) = '7');
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_correlation_uuid_v7_check"
CHECK (substring("correlation_id"::text FROM 15 FOR 1) = '7');
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_causation_uuid_v7_check"
CHECK ("causation_id" IS NULL OR substring("causation_id"::text FROM 15 FOR 1) = '7');
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_trace_id_check"
CHECK ("trace_id" ~ '^[0-9a-f]{32}$');
