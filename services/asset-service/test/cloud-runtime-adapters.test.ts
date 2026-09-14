import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DescribeKeyRequest, GetSecretValueRequest, VerifyMacRequest } from '@alicloud/kms20160120';
import {
  AlibabaCloudKmsAdapter,
  AlibabaCloudRamRoleCredentials,
  readOfficialStsSession,
} from '../src/adapters/aliyun-runtime.adapters.js';

describe('asset official cloud runtime adapters', () => {
  it('uses the official KMS and workload credential boundaries', async () => {
    const kmsClient = {
      getSecretValue: vi.fn().mockResolvedValue({ secretData: 'cdn-secret' }),
      verifyMac: vi.fn().mockResolvedValue({ value: true }),
      describeKey: vi.fn().mockResolvedValue({ keyMetadata: { keyId: 'asset-key' } }),
    };
    const kms = new AlibabaCloudKmsAdapter({ client: kmsClient as never });
    await expect(kms.resolveSecret('kms://asset/cdn-key')).resolves.toBe('cdn-secret');
    expect(kmsClient.getSecretValue).toHaveBeenCalled();
    expect(kmsClient.getSecretValue.mock.calls[0]?.[0]).toBeInstanceOf(GetSecretValueRequest);
    await kms.verifyMac({
      kmsKeyReference: 'kms://asset/mac',
      algorithm: 'HMAC_SHA_256',
      message: Buffer.from('body'),
      mac: 'mac',
    });
    expect(kmsClient.verifyMac.mock.calls[0]?.[0]).toBeInstanceOf(VerifyMacRequest);
    await expect(kms.resolveKeyId('kms://asset/key')).resolves.toBe('asset-key');
    expect(kmsClient.describeKey.mock.calls[0]?.[0]).toBeInstanceOf(DescribeKeyRequest);
    const provider = {
      getCredentials: vi.fn().mockResolvedValue({
        accessKeyId: 'id',
        accessKeySecret: 'secret',
        securityToken: 'token',
      }),
    };
    await expect(new AlibabaCloudRamRoleCredentials(provider).get()).resolves.toEqual({
      accessKeyId: 'id',
      accessKeySecret: 'secret',
      securityToken: 'token',
    });
  });

  it('rejects a KMS DescribeKey response that does not contain a bare CMK id', async () => {
    const kms = new AlibabaCloudKmsAdapter({
      client: {
        getSecretValue: vi.fn(),
        verifyMac: vi.fn(),
        describeKey: vi.fn().mockResolvedValue({ keyMetadata: { keyId: 'kms://asset/key' } }),
      } as never,
    });
    await expect(kms.resolveKeyId('kms://asset/key')).rejects.toThrow('KMS_KEY_ID_UNAVAILABLE');
  });

  it('propagates the official STS ISO expiration and rejects expired or overlong sessions', async () => {
    const now = new Date('2026-09-15T00:00:00.000Z');
    const provider = (expiration: string) => ({
      getSession: vi.fn().mockResolvedValue({
        accessKeyId: 'id',
        accessKeySecret: 'secret',
        securityToken: 'token',
        expiration,
      }),
    });
    await expect(
      readOfficialStsSession(provider('2026-09-15T00:02:00.000Z'), now),
    ).resolves.toMatchObject({ expiresAt: new Date('2026-09-15T00:02:00.000Z') });
    await expect(readOfficialStsSession(provider('2026-09-14T23:59:59.000Z'), now)).rejects.toThrow(
      'STS_CREDENTIALS_EXPIRED',
    );
    await expect(readOfficialStsSession(provider('2026-09-15T01:01:00.000Z'), now)).rejects.toThrow(
      'STS_EXPIRATION_OUT_OF_RANGE',
    );
  });

  it('production main contains no invented internal KMS/RAM/auth URL contract', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/main.ts'), 'utf8');
    expect(source).not.toMatch(
      /KMS_SERVICE_URL|RAM_SERVICE_URL|AUTH_VERIFY_URL|\/v1\/(?:sessions|secrets|mac|data-keys)/,
    );
    expect(source).toMatch(/AlibabaCloudKmsAdapter|OidcIdentityTokenVerifier/);
    expect(source).not.toMatch(/expiresAt:\s*new Date\(Date\.now\(\)\s*\+/);
    expect(source).toContain('readOfficialStsSession');
  });

  it('drives the official KMS client against a local protocol sandbox', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          SecretData: 'sandbox-secret',
          KeyMetadata: { KeyId: 'sandbox-key' },
          RequestId: 'request-1',
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('sandbox unavailable');
      const adapter = new AlibabaCloudKmsAdapter({
        regionId: 'cn-shanghai',
        endpoint: `127.0.0.1:${String(address.port)}`,
        protocol: 'HTTP',
        credentials: {
          getCredentials: () =>
            Promise.resolve({
              accessKeyId: 'test-id',
              accessKeySecret: 'test-secret',
              securityToken: 'test-token',
              providerName: 'sandbox',
            } as never),
          getProviderName: () => 'sandbox',
        },
      });
      await expect(adapter.resolveSecret('kms://asset/sandbox')).resolves.toBe('sandbox-secret');
      await expect(adapter.resolveKeyId('kms://asset/sandbox')).resolves.toBe('sandbox-key');
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        }),
      );
    }
  });
});
