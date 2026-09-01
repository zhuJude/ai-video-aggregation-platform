ALTER TABLE "admin_sessions"
ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN "pending_kind" TEXT,
ADD COLUMN "pending_challenge_id" UUID,
ADD COLUMN "pending_recovery_code_id" UUID,
ADD COLUMN "pending_totp_time_step" BIGINT,
ADD COLUMN "pending_predecessor_id" UUID,
ADD COLUMN "pending_expires_at" TIMESTAMP(3);

ALTER TABLE "mfa_challenges"
ADD COLUMN "reserved_session_id" UUID,
ADD COLUMN "reserved_until" TIMESTAMP(3);

ALTER TABLE "mfa_recovery_codes"
ADD COLUMN "reserved_session_id" UUID,
ADD COLUMN "reserved_until" TIMESTAMP(3);

CREATE INDEX "admin_sessions_status_pending_expires_at_idx"
ON "admin_sessions"("status", "pending_expires_at");
