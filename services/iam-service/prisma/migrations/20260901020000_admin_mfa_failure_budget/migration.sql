ALTER TABLE "admin_users"
  ADD COLUMN "mfa_failure_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "mfa_failure_window_started_at" TIMESTAMP(3),
  ADD COLUMN "mfa_locked_until" TIMESTAMP(3),
  ADD CONSTRAINT "admin_users_mfa_failure_count_check" CHECK ("mfa_failure_count" >= 0);

CREATE INDEX "admin_users_mfa_locked_until_idx" ON "admin_users"("mfa_locked_until");
