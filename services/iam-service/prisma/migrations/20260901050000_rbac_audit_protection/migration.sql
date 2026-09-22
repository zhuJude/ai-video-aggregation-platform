ALTER TABLE "audit_events"
  ADD COLUMN "outcome" TEXT NOT NULL DEFAULT 'SUCCESS',
  ADD COLUMN "reason_code" TEXT;

ALTER TABLE "audit_events"
  ADD CONSTRAINT "audit_events_outcome_check" CHECK ("outcome" IN ('SUCCESS', 'DENIED'));

CREATE INDEX "audit_events_outcome_occurred_at_idx"
  ON "audit_events"("outcome", "occurred_at");

CREATE UNIQUE INDEX "roles_single_protected_idx"
  ON "roles" (("protected")) WHERE "protected" = true;

CREATE OR REPLACE FUNCTION protect_system_role() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."protected" THEN
      RAISE EXCEPTION 'protected role cannot be deleted' USING ERRCODE = 'P0001';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."protected" OR NEW."protected" IS DISTINCT FROM OLD."protected" THEN
    RAISE EXCEPTION 'protected role cannot be modified' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "roles_protect_system_role"
BEFORE UPDATE OR DELETE ON "roles"
FOR EACH ROW EXECUTE FUNCTION protect_system_role();

CREATE OR REPLACE FUNCTION protect_system_role_permissions() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  affected_role UUID;
BEGIN
  affected_role := CASE WHEN TG_OP = 'DELETE' THEN OLD."role_id" ELSE NEW."role_id" END;
  IF EXISTS (SELECT 1 FROM "roles" WHERE "id" = affected_role AND "protected" = true) THEN
    RAISE EXCEPTION 'protected role permissions cannot be modified' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "role_permissions_protect_system_role"
BEFORE INSERT OR UPDATE OR DELETE ON "role_permissions"
FOR EACH ROW EXECUTE FUNCTION protect_system_role_permissions();

CREATE OR REPLACE FUNCTION protect_last_super_admin_assignment() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remaining INTEGER;
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD."admin_id" = NEW."admin_id"
     AND OLD."role_id" = NEW."role_id" THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "roles" WHERE "id" = OLD."role_id" AND "protected" = true) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "admin_users" WHERE "id" = OLD."admin_id" AND "status" = 'ACTIVE') THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('iam:super-admin', 0));
  SELECT count(DISTINCT ar."admin_id") INTO remaining
  FROM "admin_roles" ar
  JOIN "roles" r ON r."id" = ar."role_id" AND r."protected" = true
  JOIN "admin_users" a ON a."id" = ar."admin_id" AND a."status" = 'ACTIVE'
  WHERE NOT (ar."admin_id" = OLD."admin_id" AND ar."role_id" = OLD."role_id");
  IF remaining < 1 THEN
    RAISE EXCEPTION 'last active super administrator is protected' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "admin_roles_protect_last_super_admin"
BEFORE UPDATE OR DELETE ON "admin_roles"
FOR EACH ROW EXECUTE FUNCTION protect_last_super_admin_assignment();

CREATE OR REPLACE FUNCTION protect_last_super_admin_account() RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  remaining INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' AND NOT (OLD."status" = 'ACTIVE' AND NEW."status" <> 'ACTIVE') THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "admin_roles" ar
    JOIN "roles" r ON r."id" = ar."role_id"
    WHERE ar."admin_id" = OLD."id" AND r."protected" = true
  ) THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('iam:super-admin', 0));
  SELECT count(DISTINCT ar."admin_id") INTO remaining
  FROM "admin_roles" ar
  JOIN "roles" r ON r."id" = ar."role_id" AND r."protected" = true
  JOIN "admin_users" a ON a."id" = ar."admin_id" AND a."status" = 'ACTIVE'
  WHERE ar."admin_id" <> OLD."id";
  IF remaining < 1 THEN
    RAISE EXCEPTION 'last active super administrator is protected' USING ERRCODE = 'P0001';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER "admin_users_protect_last_super_admin"
BEFORE UPDATE OR DELETE ON "admin_users"
FOR EACH ROW EXECUTE FUNCTION protect_last_super_admin_account();
