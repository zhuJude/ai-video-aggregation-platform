import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

describe('IAM persistence migration', () => {
  it('creates isolated administrator, MFA, session, RBAC and append-only audit tables', () => {
    const sql = readFileSync(
      join(import.meta.dirname, '../prisma/migrations/20260901010000_admin_mfa/migration.sql'),
      'utf8',
    );
    for (const table of [
      'admin_users',
      'admin_sessions',
      'mfa_challenges',
      'mfa_recovery_codes',
      'roles',
      'permissions',
      'admin_roles',
      'role_permissions',
      'audit_events',
    ]) {
      expect(sql).toContain(`CREATE TABLE "${table}"`);
    }
    expect(sql).toContain('CREATE OR REPLACE FUNCTION iam_uuid_v7()');
    expect(sql).toContain('CREATE TRIGGER "audit_events_append_only"');
    expect(sql).toContain('CREATE TRIGGER "audit_events_no_truncate"');
    expect(sql).toContain('RAISE EXCEPTION');
    expect(sql).not.toMatch(/uuid_generate_v4|gen_random_uuid\(\)\s+DEFAULT/i);
  });

  it('keeps refresh tokens, challenges, passwords and recovery codes digest-only', () => {
    const schema = readFileSync(join(import.meta.dirname, '../prisma/schema.prisma'), 'utf8');
    expect(schema).toContain('passwordHash');
    expect(schema).toContain('refreshTokenDigest');
    expect(schema).toContain('challengeDigest');
    expect(schema).toContain('digest');
    expect(schema).toContain('causationId');
    expect(schema).not.toMatch(/refreshToken\s+String/);
    expect(schema).not.toMatch(/recoveryCode\s+String/);
    expect(schema).not.toMatch(/totpSecret\s+String/);
  });

  it('adds a forward-only persistent administrator MFA failure budget', () => {
    const sql = readFileSync(
      join(
        import.meta.dirname,
        '../prisma/migrations/20260901020000_admin_mfa_failure_budget/migration.sql',
      ),
      'utf8',
    );
    expect(sql).toContain('ADD COLUMN "mfa_failure_count" INTEGER NOT NULL DEFAULT 0');
    expect(sql).toContain('ADD COLUMN "mfa_failure_window_started_at" TIMESTAMP(3)');
    expect(sql).toContain('ADD COLUMN "mfa_locked_until" TIMESTAMP(3)');
    expect(sql).toContain('CHECK ("mfa_failure_count" >= 0)');
  });
});
