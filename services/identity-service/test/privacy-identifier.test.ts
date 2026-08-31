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
    const domains = ['redis-phone', 'redis-ip', 'redis-device', 'log-phone'] as const;
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
