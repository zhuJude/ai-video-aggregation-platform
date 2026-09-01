import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { HmacPrivacyIdentifierHasher } from '../src/adapters/hmac-privacy-identifier.hasher.js';
import { HmacChallengeCodeHasher } from '../src/adapters/hmac-challenge-code.hasher.js';

describe('HmacPrivacyIdentifierHasher', () => {
  it('domain-separates the same raw identifier and never emits its plain SHA-256 dictionary hash', async () => {
    const hasher = new HmacPrivacyIdentifierHasher(
      { getPrivacyIdentifierSecret: () => Promise.resolve(Buffer.alloc(32, 7)) },
      'kms://identity/privacy-identifiers#version=2026-08-31',
    );
    const raw = '+8613800138000';
    const domains = [
      'redis-phone',
      'redis-ip',
      'redis-device',
      'log-phone',
      'account-operation',
    ] as const;
    const identifiers = await Promise.all(domains.map((domain) => hasher.hash(domain, raw)));

    expect(new Set(identifiers).size).toBe(domains.length);
    expect(identifiers).not.toContain(createHash('sha256').update(raw).digest('hex'));
    expect(identifiers.every((identifier) => /^[a-f0-9]{64}$/.test(identifier))).toBe(true);
  });

  it('requires a versioned KMS reference', () => {
    expect(
      () =>
        new HmacPrivacyIdentifierHasher(
          { getPrivacyIdentifierSecret: () => Promise.resolve(Buffer.alloc(32, 7)) },
          'kms://identity/privacy-identifiers',
        ),
    ).toThrow('INVALID_VERSIONED_KMS_REFERENCE');
  });

  it('returns current and previous versioned HMAC candidates during key rotation', async () => {
    const secretByReference = new Map([
      ['kms://identity/privacy-identifiers#version=v2', Buffer.alloc(32, 2)],
      ['kms://identity/privacy-identifiers#version=v1', Buffer.alloc(32, 1)],
    ]);
    const hasher = new HmacPrivacyIdentifierHasher(
      {
        getPrivacyIdentifierSecret: (reference) =>
          Promise.resolve(secretByReference.get(reference) ?? Buffer.alloc(0)),
      },
      'kms://identity/privacy-identifiers#version=v2',
      ['kms://identity/privacy-identifiers#version=v1'],
    );

    const current = await hasher.hashCurrent('account-operation', 'intent');
    const candidates = await hasher.hashCandidates('account-operation', 'intent');

    expect(current.keyVersion).toBe('v2');
    expect(candidates.map(({ keyVersion }) => keyVersion)).toEqual(['v2', 'v1']);
    expect(candidates.map(({ digest }) => digest)).toHaveLength(2);
    expect(new Set(candidates.map(({ digest }) => digest)).size).toBe(2);
    await expect(hasher.hash('account-operation', 'intent')).resolves.toBe(current.digest);
  });

  it('also requires the OTP challenge key to use a stable KMS version', () => {
    expect(
      () =>
        new HmacChallengeCodeHasher(
          { getSecret: () => Promise.resolve(Buffer.alloc(32, 5)) },
          'kms://identity/sms-otp',
        ),
    ).toThrow('SMS_CHALLENGE_VERSIONED_KMS_REFERENCE_REQUIRED');
  });

  it.each(['latest', 'current', 'active'])('rejects floating KMS version alias %s', (version) => {
    expect(
      () =>
        new HmacPrivacyIdentifierHasher(
          { getPrivacyIdentifierSecret: () => Promise.resolve(Buffer.alloc(32, 7)) },
          `kms://identity/privacy-identifiers#version=${version}`,
        ),
    ).toThrow('INVALID_VERSIONED_KMS_REFERENCE');
  });
});
