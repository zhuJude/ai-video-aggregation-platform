ALTER TABLE "mfa_recovery_codes"
ADD COLUMN "pepper_version" TEXT NOT NULL DEFAULT 'legacy-v1';

DROP INDEX "mfa_recovery_codes_admin_id_generation_consumed_at_idx";
CREATE INDEX "mfa_recovery_codes_admin_id_generation_pepper_version_consumed_at_idx"
ON "mfa_recovery_codes"("admin_id", "generation", "pepper_version", "consumed_at");
