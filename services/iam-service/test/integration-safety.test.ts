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

    expect(postgres).toContain("process.env['IAM_TEST_DATABASE_URL']");
    expect(postgres).not.toContain("process.env['IAM_DATABASE_URL']");
    expect(postgres).not.toMatch(/\.deleteMany\(\s*\)/);
    expect(redis).toContain("process.env['IAM_TEST_REDIS_URL']");
    expect(redis).not.toContain("process.env['IAM_REDIS_URL']");
    expect(redis).not.toMatch(/\.(?:flushdb|flushall|scan|keys)\s*\(/i);
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
