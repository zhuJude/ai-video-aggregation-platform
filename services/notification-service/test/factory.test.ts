import { describe, expect, it, vi } from 'vitest';
import { createNotificationServices } from '../src/application/notification-service.factory.js';

describe('production factory', () => {
  it('requires explicit verified auth and KMS-resolved RAM role dependencies', async () => {
    const services = await createNotificationServices({
      prisma: {} as never,
      kms: { generateDataKey: vi.fn(), decryptDataKey: vi.fn() },
      phoneKmsReference: 'kms://prod/notification/phone-key',
      smsCredentialKms: { resolveSecret: vi.fn().mockResolvedValue('external-id-from-kms') },
      ramRoleIssuer: {
        assumeRole: vi.fn().mockResolvedValue({
          accessKeyId: 'sts-id',
          accessKeySecret: 'sts-secret',
          securityToken: 'sts-token',
          expiresAt: new Date('2099-09-14T13:00:00Z'),
        }),
      },
      smsConfig: {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
      userTokenVerifier: { verify: vi.fn() },
      auth: { issuer: 'https://issuer', audience: 'notification' },
    });
    expect(services.consumer).toBeInstanceOf(Object);
    expect(services.worker).toBeInstanceOf(Object);
    expect(services.http).toBeInstanceOf(Object);
  });
});
