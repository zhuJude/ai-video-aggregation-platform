CREATE SCHEMA IF NOT EXISTS "public";

CREATE OR REPLACE FUNCTION iam_uuid_v7() RETURNS UUID
LANGUAGE SQL VOLATILE PARALLEL SAFE
AS $$
SELECT (
  lpad(to_hex(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint), 12, '0') ||
  '7' || substr(replace(gen_random_uuid()::text, '-', ''), 2, 3) ||
  '8' || substr(replace(gen_random_uuid()::text, '-', ''), 2, 3) ||
  substr(replace(gen_random_uuid()::text, '-', ''), 2, 12)
)::uuid;
$$;

CREATE TABLE "admin_users" (
  "id" UUID NOT NULL DEFAULT iam_uuid_v7(),
  "email" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
  "pending_totp_secret_ciphertext" TEXT,
  "totp_secret_ciphertext" TEXT,
  "last_totp_time_step" BIGINT,
  "recovery_generation" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_users_id_uuid_v7_check" CHECK (substring("id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "admin_users_mfa_state_check" CHECK (
    ("mfa_enabled" = false) OR
    ("totp_secret_ciphertext" IS NOT NULL AND "recovery_generation" IS NOT NULL)
  ),
  CONSTRAINT "admin_users_recovery_generation_uuid_v7_check" CHECK (
    "recovery_generation" IS NULL OR substring("recovery_generation"::text FROM 15 FOR 1) = '7'
  )
);
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

CREATE TABLE "admin_sessions" (
  "id" UUID NOT NULL DEFAULT iam_uuid_v7(),
  "admin_id" UUID NOT NULL,
  "family_id" UUID NOT NULL,
  "refresh_token_digest" CHAR(64) NOT NULL,
  "device_name" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "admin_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "admin_sessions_id_uuid_v7_check" CHECK (substring("id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "admin_sessions_family_uuid_v7_check" CHECK (substring("family_id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "admin_sessions_refresh_digest_check" CHECK ("refresh_token_digest" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "admin_sessions_refresh_token_digest_key" ON "admin_sessions"("refresh_token_digest");
CREATE INDEX "admin_sessions_admin_id_revoked_at_idx" ON "admin_sessions"("admin_id", "revoked_at");
CREATE INDEX "admin_sessions_family_id_revoked_at_idx" ON "admin_sessions"("family_id", "revoked_at");

CREATE TABLE "mfa_challenges" (
  "id" UUID NOT NULL DEFAULT iam_uuid_v7(),
  "admin_id" UUID NOT NULL,
  "challenge_digest" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_challenges_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_challenges_id_uuid_v7_check" CHECK (substring("id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "mfa_challenges_digest_check" CHECK ("challenge_digest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "mfa_challenges_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "mfa_challenges_challenge_digest_key" ON "mfa_challenges"("challenge_digest");
CREATE INDEX "mfa_challenges_admin_id_created_at_idx" ON "mfa_challenges"("admin_id", "created_at");

CREATE TABLE "mfa_recovery_codes" (
  "id" UUID NOT NULL DEFAULT iam_uuid_v7(),
  "admin_id" UUID NOT NULL,
  "generation" UUID NOT NULL,
  "digest" CHAR(64) NOT NULL,
  "consumed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mfa_recovery_codes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "mfa_recovery_codes_id_uuid_v7_check" CHECK (substring("id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "mfa_recovery_codes_generation_uuid_v7_check" CHECK (substring("generation"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "mfa_recovery_codes_digest_check" CHECK ("digest" ~ '^[0-9a-f]{64}$')
);
CREATE UNIQUE INDEX "mfa_recovery_codes_digest_key" ON "mfa_recovery_codes"("digest");
CREATE INDEX "mfa_recovery_codes_admin_id_generation_consumed_at_idx" ON "mfa_recovery_codes"("admin_id", "generation", "consumed_at");

CREATE TABLE "roles" (
  "id" UUID NOT NULL DEFAULT iam_uuid_v7(),
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "data_scope" TEXT NOT NULL DEFAULT 'OWN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "protected" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "roles_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "roles_id_uuid_v7_check" CHECK (substring("id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "roles_data_scope_check" CHECK ("data_scope" IN ('ALL', 'OWN', 'ASSIGNED')),
  CONSTRAINT "roles_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "roles_name_key" ON "roles"("name");

CREATE TABLE "permissions" (
  "id" UUID NOT NULL DEFAULT iam_uuid_v7(),
  "key" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "permissions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "permissions_id_uuid_v7_check" CHECK (substring("id"::text FROM 15 FOR 1) = '7')
);
CREATE UNIQUE INDEX "permissions_key_key" ON "permissions"("key");

CREATE TABLE "admin_roles" (
  "admin_id" UUID NOT NULL,
  "role_id" UUID NOT NULL,
  "assigned_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "assigned_by" UUID NOT NULL,
  CONSTRAINT "admin_roles_pkey" PRIMARY KEY ("admin_id", "role_id")
);
CREATE INDEX "admin_roles_role_id_idx" ON "admin_roles"("role_id");

CREATE TABLE "role_permissions" (
  "role_id" UUID NOT NULL,
  "permission_id" UUID NOT NULL,
  CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id", "permission_id")
);
CREATE INDEX "role_permissions_permission_id_idx" ON "role_permissions"("permission_id");

CREATE TABLE "audit_events" (
  "id" UUID NOT NULL DEFAULT iam_uuid_v7(),
  "actor_id" UUID,
  "action" TEXT NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" TEXT,
  "before" JSONB,
  "after" JSONB,
  "ip_address" TEXT NOT NULL,
  "user_agent" TEXT NOT NULL,
  "trace_id" CHAR(32) NOT NULL,
  "correlation_id" UUID NOT NULL,
  "causation_id" UUID,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "audit_events_id_uuid_v7_check" CHECK (substring("id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "audit_events_correlation_uuid_v7_check" CHECK (substring("correlation_id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "audit_events_causation_uuid_v7_check" CHECK ("causation_id" IS NULL OR substring("causation_id"::text FROM 15 FOR 1) = '7'),
  CONSTRAINT "audit_events_trace_id_check" CHECK ("trace_id" ~ '^[0-9a-f]{32}$')
);
CREATE INDEX "audit_events_occurred_at_idx" ON "audit_events"("occurred_at");
CREATE INDEX "audit_events_actor_id_occurred_at_idx" ON "audit_events"("actor_id", "occurred_at");
CREATE INDEX "audit_events_resource_type_resource_id_occurred_at_idx" ON "audit_events"("resource_type", "resource_id", "occurred_at");

ALTER TABLE "admin_sessions" ADD CONSTRAINT "admin_sessions_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mfa_challenges" ADD CONSTRAINT "mfa_challenges_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "mfa_recovery_codes" ADD CONSTRAINT "mfa_recovery_codes_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_admin_id_fkey" FOREIGN KEY ("admin_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "admin_roles" ADD CONSTRAINT "admin_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION reject_audit_event_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'audit_events are append-only';
END;
$$;
CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();
CREATE TRIGGER "audit_events_no_truncate"
BEFORE TRUNCATE ON "audit_events"
FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_mutation();
