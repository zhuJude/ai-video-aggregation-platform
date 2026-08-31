import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  AliyunSmsSender,
  ALIYUN_SMS_SDK_COMPATIBILITY,
  type AliyunSmsClient,
  type AliyunSmsClientProvider,
} from '../src/adapters/aliyun-sms.sender.js';
import { LoggingSmsSender } from '../src/adapters/logging-sms.sender.js';
import { HmacPrivacyIdentifierHasher } from '../src/adapters/hmac-privacy-identifier.hasher.js';

const signReference = 'kms://identity/aliyun-sms-sign#version=1';
const templateReference = 'kms://identity/aliyun-sms-template#version=1';
const roleReference = 'kms://identity/aliyun-sms-role#version=1';

function roleConfiguration(credentialKind = 'ecs_ram_role') {
  return {
    credentialKind,
    signNameKmsReference: signReference,
    templateCodeKmsReference: templateReference,
    roleKmsReference: roleReference,
  };
}

describe('AliyunSmsSender', () => {
  it('converts +86 E.164 at the boundary and sends only the code template variable', async () => {
    const sendSms = vi.fn<AliyunSmsClient['sendSms']>().mockResolvedValue({ body: { code: 'OK' } });
    const getClient = vi.fn<AliyunSmsClientProvider['getClient']>().mockResolvedValue({ sendSms });
    const resolveValue = vi.fn((kmsReference: string) => {
      const values: Record<string, string> = {
        [signReference]: 'configured-sign',
        [templateReference]: 'configured-template',
      };
      return Promise.resolve(values[kmsReference] ?? '');
    });
    const sender = new AliyunSmsSender(
      { getClient },
      {
        getReferences: () => Promise.resolve(roleConfiguration()),
      },
      { resolveValue },
    );

    await sender.sendCode('+8613800138000', '123456');

    expect(getClient).toHaveBeenCalledWith({
      credentialKind: 'ecs_ram_role',
      roleKmsReference: roleReference,
      sdkCompatibility: ALIYUN_SMS_SDK_COMPATIBILITY,
    });
    expect(resolveValue.mock.calls).toEqual([[signReference], [templateReference]]);
    expect(sendSms).toHaveBeenCalledOnce();
    expect(sendSms.mock.calls[0]?.[0]).toMatchObject({
      phoneNumbers: '13800138000',
      signName: 'configured-sign',
      templateCode: 'configured-template',
      templateParam: JSON.stringify({ code: '123456' }),
    });
    expect(JSON.stringify(getClient.mock.calls)).not.toMatch(/access.?key/i);
  });

  it('rejects non-mainland phone numbers and malformed codes', async () => {
    const provider: AliyunSmsClientProvider = {
      getClient: () =>
        Promise.resolve({ sendSms: () => Promise.resolve({ body: { code: 'OK' } }) }),
    };
    const sender = new AliyunSmsSender(
      provider,
      {
        getReferences: () =>
          Promise.resolve({
            ...roleConfiguration(),
          }),
      },
      { resolveValue: () => Promise.resolve('configured') },
    );

    await expect(sender.sendCode('+85261234567', '123456')).rejects.toMatchObject({
      code: 'INVALID_PHONE',
    });
    await expect(sender.sendCode('+8613800138000', 'not-a-code')).rejects.toMatchObject({
      code: 'INVALID_SMS_CODE',
    });
  });

  it('declares structural compatibility with the official v4.6.0 SDK', () => {
    expect(ALIYUN_SMS_SDK_COMPATIBILITY).toEqual({
      packageName: '@alicloud/dysmsapi20170525',
      version: '4.6.0',
    });
  });

  it('rejects missing KMS references before constructing an SDK client', async () => {
    const getClient = vi.fn<AliyunSmsClientProvider['getClient']>();
    const sender = new AliyunSmsSender(
      { getClient },
      {
        getReferences: () => Promise.resolve({ ...roleConfiguration(), signNameKmsReference: '' }),
      },
      { resolveValue: () => Promise.resolve('configured') },
    );

    await expect(sender.sendCode('+8613800138000', '123456')).rejects.toThrow(
      'ALIYUN_SMS_KMS_REFERENCES_REQUIRED',
    );
    expect(getClient).not.toHaveBeenCalled();
  });

  it('maps a non-OK official SDK response to a stable error', async () => {
    const sender = new AliyunSmsSender(
      {
        getClient: () =>
          Promise.resolve({
            sendSms: () => Promise.resolve({ body: { code: 'isv.BUSINESS_LIMIT_CONTROL' } }),
          }),
      },
      {
        getReferences: () =>
          Promise.resolve({
            ...roleConfiguration('oidc_role_arn'),
          }),
      },
      { resolveValue: () => Promise.resolve('configured') },
    );

    await expect(sender.sendCode('+8613800138000', '123456')).rejects.toMatchObject({
      code: 'ALIYUN_SMS_SEND_FAILED',
    });
  });

  it.each(['ecs_ram_role', 'oidc_role_arn'] as const)(
    'allows explicit role credential mode %s',
    async (credentialKind) => {
      const getClient = vi.fn<AliyunSmsClientProvider['getClient']>().mockResolvedValue({
        sendSms: () => Promise.resolve({ body: { code: 'OK' } }),
      });
      const sender = new AliyunSmsSender(
        { getClient },
        { getReferences: () => Promise.resolve(roleConfiguration(credentialKind)) },
        { resolveValue: () => Promise.resolve('configured') },
      );

      await sender.sendCode('+8613800138000', '123456');
      expect(getClient).toHaveBeenCalledWith(
        expect.objectContaining({ credentialKind, roleKmsReference: roleReference }),
      );
    },
  );

  it.each(['access_key', 'config_file', 'default_chain'])(
    'rejects unsupported credential kind %s before constructing a client',
    async (credentialKind) => {
      const getClient = vi.fn<AliyunSmsClientProvider['getClient']>();
      const sender = new AliyunSmsSender(
        { getClient },
        { getReferences: () => Promise.resolve(roleConfiguration(credentialKind)) },
        { resolveValue: () => Promise.resolve('configured') },
      );

      await expect(sender.sendCode('+8613800138000', '123456')).rejects.toMatchObject({
        code: 'ALIYUN_SMS_UNSUPPORTED_CREDENTIAL_KIND',
      });
      expect(getClient).not.toHaveBeenCalled();
    },
  );
});

describe('LoggingSmsSender', () => {
  it('is local-only and logs a phone hash plus template key without code or full phone', async () => {
    const info = vi.fn();
    const privacyHasher = new HmacPrivacyIdentifierHasher(
      { getPrivacyIdentifierSecret: () => Promise.resolve(Buffer.alloc(32, 9)) },
      'kms://identity/log-privacy#version=1',
    );
    const sender = new LoggingSmsSender('local', 'local-login-template', { info }, privacyHasher);

    await sender.sendCode('+8613800138000', '123456');

    expect(info).toHaveBeenCalledWith('Local SMS challenge requested', {
      phoneHash: await privacyHasher.hash('log-phone', '+8613800138000'),
      templateKey: 'local-login-template',
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain('123456');
    expect(JSON.stringify(info.mock.calls)).not.toContain('+8613800138000');
    expect(JSON.stringify(info.mock.calls)).not.toContain(
      createHash('sha256').update('+8613800138000').digest('hex'),
    );
  });

  it('cannot be constructed outside APP_ENV=local', () => {
    expect(
      () =>
        new LoggingSmsSender(
          'production',
          'template',
          { info: vi.fn() },
          {
            hash: () => Promise.resolve('not-used'),
          },
        ),
    ).toThrow('LOGGING_SMS_SENDER_LOCAL_ONLY');
  });
});
