import { describe, expect, it } from 'vitest';

import { identityLockKeys } from '../src/domain/identity-lock-key.js';

const userId = '0198fabc-1234-7abc-8abc-111111111111';
const familyId = '0198fabc-1234-7abc-8abc-222222222222';
const operationId = '0198fabc-1234-7abc-8abc-333333333333';

describe('identity advisory lock protocol', () => {
  it('gives ancestor reuse, descendant rotate, logout, and revoke the same ordered locks', () => {
    const sessionLocks = identityLockKeys({ userId, sessionFamilyId: familyId });

    expect(sessionLocks).toEqual([
      `identity-account:${userId}`,
      `identity-session-family:${familyId}`,
    ]);
    expect(identityLockKeys({ userId, sessionFamilyId: familyId })).toEqual(sessionLocks);
  });

  it('makes account close and every session write contend on the account lock first', () => {
    const accountCloseLocks = identityLockKeys({ userId, operationId });
    const sessionWriteLocks = identityLockKeys({ userId, sessionFamilyId: familyId });

    expect(accountCloseLocks[0]).toBe(`identity-account:${userId}`);
    expect(sessionWriteLocks[0]).toBe(`identity-account:${userId}`);
    expect(accountCloseLocks[0]).toBe(sessionWriteLocks[0]);
  });
});
