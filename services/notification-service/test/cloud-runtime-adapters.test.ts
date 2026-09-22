import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  DecryptRequest,
  DescribeKeyRequest,
  GenerateDataKeyRequest,
  GetSecretValueRequest,
} from '@alicloud/kms20160120';
import {
  AlibabaCloudKmsDataKeys,
  readOfficialStsSession,
} from '../src/adapters/aliyun-runtime.adapters.js';

describe('notification official cloud runtime adapters', () => {
  it('maps official KMS data-key responses without logging plaintext', async () => {
    const client = {
      generateDataKey: vi.fn().mockResolvedValue({
        plaintext: Buffer.alloc(32, 1).toString('base64'),
        ciphertextBlob: 'wrapped',
        keyVersionId: 'v1',
      }),
      decrypt: vi.fn().mockResolvedValue({ plaintext: Buffer.alloc(32, 1).toString('base64') }),
      getSecretValue: vi.fn().mockResolvedValue({ secretData: 'external-id' }),
      describeKey: vi.fn().mockResolvedValue({ keyMetadata: { keyId: 'phone' } }),
    };
    const adapter = new AlibabaCloudKmsDataKeys({ client: client as never });
    await expect(adapter.generateDataKey('kms://notification/phone')).resolves.toMatchObject({
      keyVersion: 'v1',
    });
    await expect(adapter.resolveSecret('kms://notification/sms-external-id')).resolves.toBe(
      'external-id',
    );
    await adapter.decryptDataKey({ wrappedKey: Buffer.from('wrapped'), keyVersion: 'v1' });
    await adapter.pingKey('kms://notification/phone');
    expect(client.generateDataKey.mock.calls[0]?.[0]).toBeInstanceOf(GenerateDataKeyRequest);
    expect(client.decrypt.mock.calls[0]?.[0]).toBeInstanceOf(DecryptRequest);
    expect(client.getSecretValue.mock.calls[0]?.[0]).toBeInstanceOf(GetSecretValueRequest);
    expect(client.describeKey.mock.calls[0]?.[0]).toBeInstanceOf(DescribeKeyRequest);
  });

  it('production main contains no invented internal KMS/RAM/auth or arbitrary SMS health URL', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/main.ts'), 'utf8');
    expect(source).not.toMatch(
      /KMS_SERVICE_URL|RAM_SERVICE_URL|AUTH_VERIFY_URL|SMS_HEALTH_URL|\/v1\/(?:sessions|secrets|data-keys)/,
    );
    expect(source).toMatch(
      /AlibabaCloudKmsDataKeys|AlibabaCloudRamRoleIssuer|OidcUserTokenVerifier/,
    );
    expect(source).toContain('readOfficialStsSession');
    expect(source).not.toMatch(/expiresAt:\s*new Date\(Date\.now\(\)\s*\+/);
  });

  it('uses the official KMS protocol client for data-key operations', async () => {
    const plaintext = Buffer.alloc(32, 2).toString('base64');
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          Plaintext: plaintext,
          CiphertextBlob: 'wrapped',
          KeyVersionId: 'v2',
          KeyMetadata: { KeyId: 'phone' },
          RequestId: 'request-2',
        }),
      );
    });
    await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
    try {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('sandbox unavailable');
      const adapter = new AlibabaCloudKmsDataKeys({
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
      await expect(adapter.generateDataKey('kms://notification/phone')).resolves.toMatchObject({
        keyVersion: 'v2',
      });
      await expect(
        adapter.decryptDataKey({ wrappedKey: Buffer.from('wrapped'), keyVersion: 'v2' }),
      ).resolves.toEqual(Buffer.alloc(32, 2));
      await expect(adapter.pingKey('kms://notification/phone')).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolveClose, reject) =>
        server.close((error) => {
          if (error === undefined) resolveClose();
          else reject(error);
        }),
      );
    }
  });

  it('parses the official short-lived STS Expiration exactly', async () => {
    const now = new Date('2026-09-15T00:00:00.000Z');
    const result = await readOfficialStsSession(
      {
        getSession: vi.fn().mockResolvedValue({
          accessKeyId: 'id',
          accessKeySecret: 'secret',
          securityToken: 'token',
          expiration: '2026-09-15T00:00:30.000Z',
        }),
      },
      now,
    );
    expect(result.expiresAt.toISOString()).toBe('2026-09-15T00:00:30.000Z');
  });
});
