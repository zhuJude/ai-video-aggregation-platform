import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { Argon2idPasswordHasher } from '../src/adapters/argon2id-password.hasher.js';
import { LocalAesGcmSecretCipher } from '../src/adapters/local-aes-gcm-secret.cipher.js';
import { KmsSecretCipher } from '../src/adapters/kms-secret.cipher.js';

describe('administrator security adapters', () => {
  it('hashes passwords with the pinned Argon2id policy and detects weaker hashes', async () => {
    const hasher = new Argon2idPasswordHasher();
    const digest = await hasher.hash('a sufficiently long administrator password');

    expect(digest).toMatch(/^\$argon2id\$v=19\$m=65536,p=1,t=3\$/);
    expect(hasher.isPolicyDigest(digest)).toBe(true);
    expect(hasher.isPolicyDigest('$argon2id$v=19$')).toBe(false);
    expect(
      hasher.isPolicyDigest(
        `$argon2id$v=19$m=65536,p=1,t=3$${'A'.repeat(1_000_000)}$${'B'.repeat(43)}`,
      ),
    ).toBe(false);
    await expect(hasher.verify(digest.replace('m=65536', 'm=999999999'), 'wrong')).resolves.toEqual(
      { valid: false, needsRehash: false },
    );
    await expect(
      hasher.verify(digest, 'a sufficiently long administrator password'),
    ).resolves.toEqual({ valid: true, needsRehash: false });
    await expect(hasher.verify(digest, 'wrong password')).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
    await expect(hasher.verify(digest, 'x'.repeat(1_025))).resolves.toEqual({
      valid: false,
      needsRehash: false,
    });
  });

  it('snapshots KMS config and decrypts retained key versions only', async () => {
    const calls: string[] = [];
    const client = {
      encrypt: ({ keyReference }: { keyReference: string }) =>
        Promise.resolve(`cipher:${keyReference}`),
      decrypt: ({ keyReference, ciphertext }: { keyReference: string; ciphertext: string }) => {
        calls.push(keyReference);
        if (ciphertext !== `cipher:${keyReference}`) return Promise.reject(new Error('wrong key'));
        return Promise.resolve('TOPSECRET');
      },
    };
    const identity: { mode: 'ecs_ram_role'; roleName: string } = {
      mode: 'ecs_ram_role',
      roleName: 'iam-service',
    };
    const old = new KmsSecretCipher(client, {
      currentKeyReference: 'acs:kms:cn-test:123:key/totp:version/v1',
      identity,
    });
    const envelope = await old.encrypt('0198fabc-1234-7abc-8abc-000000000001', 'TOPSECRET');
    identity.roleName = 'mutated';
    const rotated = new KmsSecretCipher(client, {
      currentKeyReference: 'acs:kms:cn-test:123:key/totp:version/v2',
      previousKeyReferences: ['acs:kms:cn-test:123:key/totp:version/v1'],
      identity: { mode: 'ecs_ram_role', roleName: 'iam-service' },
    });
    await expect(rotated.decrypt('0198fabc-1234-7abc-8abc-000000000001', envelope)).resolves.toBe(
      'TOPSECRET',
    );
    const fresh = await rotated.encrypt('0198fabc-1234-7abc-8abc-000000000001', 'TOPSECRET');
    const encodedReference = fresh.split('.')[2];
    if (!encodedReference) throw new Error('EXPECTED_KEY_REFERENCE');
    expect(Buffer.from(encodedReference, 'base64url').toString()).toContain('version/v2');
    const removed = new KmsSecretCipher(client, {
      currentKeyReference: 'acs:kms:cn-test:123:key/totp:version/v2',
      identity: { mode: 'ecs_ram_role', roleName: 'iam-service' },
    });
    await expect(
      removed.decrypt('0198fabc-1234-7abc-8abc-000000000001', envelope),
    ).rejects.toMatchObject({ code: 'SECRET_DECRYPTION_FAILED' });
    expect(calls).toContain('acs:kms:cn-test:123:key/totp:version/v1');
  });

  it('encrypts TOTP secrets with random AES-GCM nonces and binds ciphertext to admin AAD', async () => {
    const key = randomBytes(32);
    const cipher = new LocalAesGcmSecretCipher(key);
    const first = await cipher.encrypt('0198fabc-1234-7abc-8abc-000000000001', 'TOPSECRET');
    const second = await cipher.encrypt('0198fabc-1234-7abc-8abc-000000000001', 'TOPSECRET');

    expect(first).toMatch(/^local-aes256gcm\.v1\./);
    expect(first).not.toBe(second);
    await expect(cipher.decrypt('0198fabc-1234-7abc-8abc-000000000001', first)).resolves.toBe(
      'TOPSECRET',
    );
    await expect(
      cipher.decrypt('0198fabc-1234-7abc-8abc-000000000002', first),
    ).rejects.toMatchObject({ code: 'SECRET_DECRYPTION_FAILED' });
    await expect(
      new LocalAesGcmSecretCipher(randomBytes(32)).decrypt(
        '0198fabc-1234-7abc-8abc-000000000001',
        first,
      ),
    ).rejects.toMatchObject({ code: 'SECRET_DECRYPTION_FAILED' });
    const envelope = first.split('.');
    const encodedTag = envelope[4];
    if (!encodedTag) throw new Error('EXPECTED_AUTH_TAG');
    const tag = Buffer.from(encodedTag, 'base64url');
    const firstTagByte = tag[0];
    if (firstTagByte === undefined) throw new Error('EXPECTED_AUTH_TAG_BYTE');
    tag[0] = firstTagByte ^ 1;
    envelope[4] = tag.toString('base64url');
    const tampered = envelope.join('.');
    await expect(
      cipher.decrypt('0198fabc-1234-7abc-8abc-000000000001', tampered),
    ).rejects.toMatchObject({ code: 'SECRET_DECRYPTION_FAILED' });
  });

  it('rejects short local keys and unversioned or static-credential KMS configuration', () => {
    expect(() => new LocalAesGcmSecretCipher(Buffer.alloc(31))).toThrow('INVALID_LOCAL_CIPHER_KEY');
    expect(() => new LocalAesGcmSecretCipher(Buffer.alloc(64))).toThrow('INVALID_LOCAL_CIPHER_KEY');
    const client = {
      encrypt: () => Promise.resolve('ciphertext'),
      decrypt: () => Promise.resolve('plaintext'),
    };
    expect(
      () =>
        new KmsSecretCipher(client, {
          keyReference: 'acs:kms:cn-hangzhou:123:key/example',
          identity: { mode: 'ecs_ram_role', roleName: 'iam-service' },
        }),
    ).toThrow('UNVERSIONED_KMS_KEY_REFERENCE');
    expect(
      () =>
        new KmsSecretCipher(client, {
          keyReference: 'not-an-aliyun-key:version/v1',
          identity: { mode: 'ecs_ram_role', roleName: 'iam-service' },
        }),
    ).toThrow('UNVERSIONED_KMS_KEY_REFERENCE');
    expect(
      () =>
        new KmsSecretCipher(client, {
          keyReference: 'acs:kms:cn-hangzhou:123:key/example:version/v1',
          identity: { mode: 'access_key' } as never,
        }),
    ).toThrow('UNSUPPORTED_KMS_IDENTITY');
  });

  it('passes only versioned references, workload identity and admin-bound AAD to KMS', async () => {
    const calls: unknown[] = [];
    const client = {
      encrypt: (input: unknown) => {
        calls.push(input);
        return Promise.resolve('provider-ciphertext');
      },
      decrypt: (input: unknown) => {
        calls.push(input);
        return Promise.resolve('TOPSECRET');
      },
    };
    const cipher = new KmsSecretCipher(client, {
      keyReference: 'acs:kms:cn-hangzhou:123:key/totp:version/v4',
      identity: {
        mode: 'oidc_role_arn',
        roleArn: 'acs:ram::123:role/iam-service',
        oidcProviderArn: 'acs:ram::123:oidc-provider/ack',
        clientId: 'iam-service',
      },
    });
    const envelope = await cipher.encrypt('0198fabc-1234-7abc-8abc-000000000001', 'TOPSECRET');
    expect(envelope).toMatch(/^aliyun-kms\.v2\./);
    await expect(cipher.decrypt('0198fabc-1234-7abc-8abc-000000000001', envelope)).resolves.toBe(
      'TOPSECRET',
    );
    expect(calls).toEqual([
      expect.objectContaining({
        keyReference: 'acs:kms:cn-hangzhou:123:key/totp:version/v4',
        plaintext: 'TOPSECRET',
        aad: 'iam-service:totp-secret:v1:0198fabc-1234-7abc-8abc-000000000001',
      }),
      expect.objectContaining({ ciphertext: 'provider-ciphertext' }),
    ]);
    await expect(
      cipher.decrypt('0198fabc-1234-7abc-8abc-000000000001', 'not-an-envelope'),
    ).rejects.toMatchObject({ code: 'SECRET_DECRYPTION_FAILED' });
  });
});
