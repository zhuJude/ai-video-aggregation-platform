import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveIamTestDatabaseUrl, resolveIamTestRedisUrl } from './test-targets.js';

describe('conditional integration safety contract', () => {
  it('uses explicit test targets and forbids broad database or Redis cleanup', () => {
    const postgres = readFileSync(
      join(import.meta.dirname, 'prisma-iam.integration.test.ts'),
      'utf8',
    );
    const redis = readFileSync(
      join(import.meta.dirname, 'redis-admin-login-throttle.test.ts'),
      'utf8',
    );
    const rbacPostgres = readFileSync(
      join(import.meta.dirname, 'prisma-rbac.integration.test.ts'),
      'utf8',
    );
    const operations = readFileSync(join(import.meta.dirname, 'operations.test.ts'), 'utf8');

    for (const source of [postgres, rbacPostgres]) {
      expect(source).toContain("process.env['IAM_TEST_DATABASE_URL']");
      expect(source).not.toContain("process.env['IAM_DATABASE_URL']");
      expect(source).not.toMatch(/\.deleteMany\(\s*\)/);
    }
    expect(rbacPostgres).toContain('finally');
    expect(rbacPostgres).toContain('DROP DATABASE');
    expect(rbacPostgres).toContain('cleanupIsolatedDatabase(false)');
    expect(rbacPostgres).toContain('cleanupIsolatedDatabase(true)');
    expect(rbacPostgres).toContain('await connected.$disconnect()');
    expect(rbacPostgres).toContain('await administrative.end()');
    expect(redis).toContain("process.env['IAM_TEST_REDIS_URL']");
    expect(redis).not.toContain("process.env['IAM_REDIS_URL']");
    expect(redis).not.toMatch(/\.(?:flushdb|flushall|scan|keys)\s*\(/i);
    expect(operations).toContain("process.env['IAM_TEST_DATABASE_URL']");
    expect(operations.indexOf('try {')).toBeLessThan(operations.indexOf('await prisma.adminUser.create'));
    expect(operations).toContain('task6SentinelKey');
    expect(operations).toContain('expectTask6FixturesRemoved');
    expect(operations).not.toMatch(/auditEvent\.deleteMany|permission\.deleteMany\(\s*\)/);
  });

  it('ignores production variables and rejects production-style explicit test targets', () => {
    expect(
      resolveIamTestDatabaseUrl({
        IAM_DATABASE_URL: 'postgresql://production.example/app',
      }),
    ).toBeNull();
    expect(() =>
      resolveIamTestDatabaseUrl({
        IAM_TEST_DATABASE_URL: 'postgresql://localhost/application',
      }),
    ).toThrow('UNSAFE_IAM_TEST_DATABASE_URL');
    expect(resolveIamTestRedisUrl({ IAM_REDIS_URL: 'redis://production.example/0' })).toBeNull();
    expect(() => resolveIamTestRedisUrl({ IAM_TEST_REDIS_URL: 'redis://localhost/0' })).toThrow(
      'UNSAFE_IAM_TEST_REDIS_URL',
    );
  });
});
