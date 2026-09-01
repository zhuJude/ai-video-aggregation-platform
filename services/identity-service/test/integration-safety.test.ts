import { describe, expect, it } from 'vitest';

import { resolveIdentityTestDatabaseUrl } from './test-targets.js';

describe('identity integration target safety', () => {
  it('ignores the production database environment variable', () => {
    expect(
      resolveIdentityTestDatabaseUrl({
        IDENTITY_DATABASE_URL: 'postgresql://identity:secret@db/identity',
      }),
    ).toBeNull();
  });

  it.each([
    'postgresql://identity:secret@db/identity',
    'postgresql://identity:secret@db/identity_testing',
    'mysql://identity:secret@db/identity_test',
    'not-a-url',
  ])('rejects unsafe targets before an integration client can connect: %s', (configured) => {
    expect(() =>
      resolveIdentityTestDatabaseUrl({ IDENTITY_TEST_DATABASE_URL: configured }),
    ).toThrow('UNSAFE_IDENTITY_TEST_DATABASE_URL');
  });

  it.each([
    'postgresql://identity:secret@db/identity_test',
    'postgres://identity:secret@db/identity_test_lock_01',
  ])('allows explicitly named isolated test databases: %s', (configured) => {
    expect(resolveIdentityTestDatabaseUrl({ IDENTITY_TEST_DATABASE_URL: configured })).toBe(
      configured,
    );
  });
});
