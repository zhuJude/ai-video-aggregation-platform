import { describe, expect, it, vi } from 'vitest';
import {
  AliyunSmsSender,
  KmsRamRoleCredentialResolver,
  RefreshingAliyunSmsClient,
  createAliyunSdkSmsClient,
  loadAliyunSmsConfig,
  maskPhone,
} from '../src/adapters/aliyun-sms.sender.js';

describe('Aliyun SMS production adapter', () => {
  it('requires KMS references and approved sign/template codes', async () => {
    expect(() =>
      loadAliyunSmsConfig({
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'plain-secret',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      }),
    ).toThrow(/KMS_REFERENCE_REQUIRED/);
    const client = { sendSms: vi.fn(), querySendDetails: vi.fn() };
    const sender = new AliyunSmsSender(client, {
      roleArn: 'acs:ram::1:role/sms',
      credentialKmsRef: 'kms://prod/notification/ram-role',
      endpoint: 'dysmsapi.aliyuncs.com',
      approvedSigns: ['平台通知'],
      approvedTemplateCodes: ['SMS_123456'],
    });
    await expect(
      sender.send({
        notificationId: '01990f24-2ba2-7000-8000-000000000001',
        phoneE164: '+8613800138000',
        signName: 'evil',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
      }),
    ).rejects.toMatchObject({ kind: 'PERMANENT', code: 'SMS_CONFIGURATION_NOT_APPROVED' });
  });

  it('never exposes a full phone in logs and records provider request ids', async () => {
    const log = vi.fn();
    const client = {
      sendSms: vi
        .fn()
        .mockResolvedValue({ body: { code: 'OK', requestId: 'req-1', bizId: 'receipt-1' } }),
      querySendDetails: vi.fn(),
    };
    const sender = new AliyunSmsSender(
      client,
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
      log,
    );
    await expect(
      sender.send({
        notificationId: '01990f24-2ba2-7000-8000-000000000001',
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: { taskId: '1' },
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
      }),
    ).resolves.toMatchObject({ status: 'ACCEPTED', requestId: 'req-1', receipt: 'receipt-1' });
    expect(JSON.stringify(log.mock.calls)).not.toContain('13800138000');
    expect(log).toHaveBeenCalledWith(
      expect.objectContaining({ phone: '+86*******000', requestId: 'req-1', receipt: 'receipt-1' }),
    );
    expect(maskPhone('+8613800138000')).toBe('+86*******000');
  });

  it('rejects OK responses without real request and receipt identifiers', async () => {
    const sender = new AliyunSmsSender(
      { sendSms: vi.fn().mockResolvedValue({ body: { code: 'OK' } }), querySendDetails: vi.fn() },
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
    );
    await expect(
      sender.send({
        notificationId: '01990f24-2ba2-7000-8000-000000000001',
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
      }),
    ).rejects.toMatchObject({ code: 'ALIYUN_MALFORMED_ACCEPTANCE', kind: 'PERMANENT' });
  });

  it('maps real QuerySendDetails receipts by stable OutId', async () => {
    const client = {
      sendSms: vi.fn(),
      querySendDetails: vi.fn().mockResolvedValue({
        body: {
          code: 'OK',
          requestId: 'query-request',
          totalCount: '1',
          smsSendDetailDTOs: {
            smsSendDetailDTO: [{ outId: '01990f24-2ba2-7000-8000-000000000001', sendStatus: 3 }],
          },
        },
      }),
    };
    const sender = new AliyunSmsSender(client, {
      roleArn: 'acs:ram::1:role/sms',
      credentialKmsRef: 'kms://prod/notification/ram-role',
      endpoint: 'dysmsapi.aliyuncs.com',
      approvedSigns: ['平台通知'],
      approvedTemplateCodes: ['SMS_123456'],
    });
    await expect(
      sender.reconcile({
        notificationId: '01990f24-2ba2-7000-8000-000000000001',
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
        receipt: 'biz-1',
      }),
    ).resolves.toEqual({ status: 'DELIVERED', requestId: 'query-request', receipt: 'biz-1' });
    expect(client.querySendDetails).toHaveBeenCalled();
    expect(client.querySendDetails.mock.calls[0]?.[0]).toMatchObject({
      bizId: 'biz-1',
      sendDate: '20260914',
    });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Vitest exposes mock tuples as any-valued metadata.
    expect(client.querySendDetails.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('creates the fixed SDK client only from KMS-resolved RAM-role credentials', async () => {
    const resolve = vi.fn().mockResolvedValue({
      accessKeyId: 'sts-id',
      accessKeySecret: 'sts-secret',
      securityToken: 'sts-token',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    const client = await createAliyunSdkSmsClient(
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
      { resolve },
    );
    expect(client).toBeDefined();
    expect(resolve).toHaveBeenCalledWith({
      roleArn: 'acs:ram::1:role/sms',
      kmsReference: 'kms://prod/notification/ram-role',
    });
  });

  it('resolves sensitive role configuration from KMS before assuming the RAM role', async () => {
    const kms = { resolveSecret: vi.fn().mockResolvedValue('external-id-from-kms') };
    const ram = {
      assumeRole: vi.fn().mockResolvedValue({
        accessKeyId: 'sts-id',
        accessKeySecret: 'sts-secret',
        securityToken: 'sts-token',
        expiresAt: new Date('2099-09-14T13:00:00Z'),
      }),
    };
    const resolver = new KmsRamRoleCredentialResolver(kms, ram);
    await expect(
      resolver.resolve({
        roleArn: 'acs:ram::1:role/sms',
        kmsReference: 'kms://prod/notification/ram-role',
      }),
    ).resolves.toMatchObject({ accessKeyId: 'sts-id', securityToken: 'sts-token' });
    expect(kms.resolveSecret).toHaveBeenCalledWith('kms://prod/notification/ram-role');
    expect(ram.assumeRole).toHaveBeenCalledWith({
      roleArn: 'acs:ram::1:role/sms',
      externalId: 'external-id-from-kms',
    });
  });

  it('fully paginates QuerySendDetails until an OutId beyond page 50 is found', async () => {
    const notificationId = '01990f24-2ba2-7000-8000-000000000001';
    const querySendDetails = vi.fn().mockImplementation((request: { currentPage?: number }) => {
      const page = request.currentPage ?? 1;
      return Promise.resolve({
        body: {
          code: 'OK',
          requestId: `query-${String(page)}`,
          totalCount: '2501',
          smsSendDetailDTOs: {
            smsSendDetailDTO:
              page === 51
                ? [{ outId: notificationId, sendStatus: 3 }]
                : Array.from({ length: 50 }, (_, index) => ({
                    outId: `other-${String(page)}-${String(index)}`,
                    sendStatus: 3,
                  })),
          },
        },
      });
    });
    const sender = new AliyunSmsSender(
      { sendSms: vi.fn(), querySendDetails },
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
    );
    await expect(
      sender.reconcile({
        notificationId,
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
      }),
    ).resolves.toMatchObject({ status: 'DELIVERED', requestId: 'query-51' });
    expect(querySendDetails).toHaveBeenCalledTimes(51);
    expect(querySendDetails.mock.calls.at(-1)?.[0]).toMatchObject({ currentPage: 51 });
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access -- Vitest exposes mock tuples as any-valued metadata.
    expect(querySendDetails.mock.calls.at(-1)?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('ignores legal non-target receipt rows with missing OutId or sendStatus', async () => {
    const notificationId = '01990f24-2ba2-7000-8000-000000000001';
    const querySendDetails = vi.fn().mockImplementation((request: { currentPage?: number }) => {
      const page = request.currentPage ?? 1;
      return Promise.resolve({
        body: {
          code: 'OK',
          requestId: `query-${String(page)}`,
          totalCount: '51',
          smsSendDetailDTOs: {
            smsSendDetailDTO:
              page === 1
                ? [
                    { sendStatus: 3 },
                    { outId: 'other-without-status' },
                    ...Array.from({ length: 48 }, (_, index) => ({
                      outId: `other-${String(index)}`,
                      sendStatus: 3,
                    })),
                  ]
                : [{ outId: notificationId, sendStatus: 3 }],
          },
        },
      });
    });
    const sender = new AliyunSmsSender(
      { sendSms: vi.fn(), querySendDetails },
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
    );
    await expect(
      sender.reconcile({
        notificationId,
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
      }),
    ).resolves.toMatchObject({ status: 'DELIVERED', requestId: 'query-2' });
    expect(querySendDetails).toHaveBeenCalledTimes(2);
  });

  it('queries the actual send date and adjacent cross-day window', async () => {
    const notificationId = '01990f24-2ba2-7000-8000-000000000001';
    const querySendDetails = vi.fn().mockImplementation((request: { sendDate?: string }) =>
      Promise.resolve({
        body: {
          code: 'OK',
          requestId: `query-${request.sendDate ?? 'missing'}`,
          totalCount: request.sendDate === '20260915' ? '1' : '0',
          smsSendDetailDTOs: {
            smsSendDetailDTO:
              request.sendDate === '20260915' ? [{ outId: notificationId, sendStatus: 3 }] : [],
          },
        },
      }),
    );
    const sender = new AliyunSmsSender(
      { sendSms: vi.fn(), querySendDetails },
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
    );
    await expect(
      sender.reconcile({
        notificationId,
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T15:59:59.000Z'),
        sendDate: '20260914',
      }),
    ).resolves.toMatchObject({ status: 'DELIVERED' });
    expect(
      querySendDetails.mock.calls.map((call) => (call[0] as { sendDate?: string }).sendDate),
    ).toEqual(['20260914', '20260915']);
  });

  it('caps receipt scans by pages and records and rejects inconsistent responses', async () => {
    const querySendDetails = vi.fn().mockResolvedValue({
      body: {
        code: 'OK',
        requestId: 'query-limit',
        totalCount: '1000',
        smsSendDetailDTOs: {
          smsSendDetailDTO: Array.from({ length: 50 }, (_, index) => ({
            outId: `other-${String(index)}`,
            sendStatus: 3,
          })),
        },
      },
    });
    const sender = new AliyunSmsSender(
      { sendSms: vi.fn(), querySendDetails },
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
      undefined,
      undefined,
      { maxPages: 2, maxRecords: 100 },
    );
    await expect(
      sender.reconcile({
        notificationId: '01990f24-2ba2-7000-8000-000000000001',
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
      }),
    ).rejects.toMatchObject({ kind: 'TRANSIENT', code: 'RECONCILIATION_SCAN_LIMIT' });
    expect(querySendDetails).toHaveBeenCalledTimes(2);

    querySendDetails.mockReset().mockResolvedValue({
      body: {
        code: 'OK',
        requestId: 'query-inconsistent',
        totalCount: '1',
        smsSendDetailDTOs: { smsSendDetailDTO: Array.from({ length: 2 }, () => ({ outId: 'x' })) },
      },
    });
    await expect(
      sender.reconcile({
        notificationId: '01990f24-2ba2-7000-8000-000000000001',
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
      }),
    ).rejects.toMatchObject({ kind: 'TRANSIENT', code: 'ALIYUN_INCONSISTENT_QUERY_RESPONSE' });

    querySendDetails.mockReset().mockResolvedValue({
      body: {
        code: 'OK',
        requestId: 'query-invalid-details',
        totalCount: '1',
        smsSendDetailDTOs: { smsSendDetailDTO: { outId: 'not-an-array' } },
      },
    });
    await expect(
      sender.reconcile({
        notificationId: '01990f24-2ba2-7000-8000-000000000001',
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        variables: {},
        sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
        sendDate: '20260914',
      }),
    ).rejects.toMatchObject({ kind: 'TRANSIENT', code: 'ALIYUN_INCONSISTENT_QUERY_RESPONSE' });
  });

  it('applies a hard abortable deadline to each SDK query', async () => {
    vi.useFakeTimers();
    try {
      const querySendDetails = vi.fn(
        (_request: unknown, options?: { signal?: AbortSignal }) =>
          new Promise<{ body: Record<string, never> }>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('aborted'));
            });
          }),
      );
      const sender = new AliyunSmsSender(
        { sendSms: vi.fn(), querySendDetails },
        {
          roleArn: 'acs:ram::1:role/sms',
          credentialKmsRef: 'kms://prod/notification/ram-role',
          endpoint: 'dysmsapi.aliyuncs.com',
          approvedSigns: ['平台通知'],
          approvedTemplateCodes: ['SMS_123456'],
        },
        undefined,
        undefined,
        { requestTimeoutMs: 100, reconcileTimeoutMs: 500 },
      );
      let failure: unknown;
      void sender
        .reconcile({
          notificationId: '01990f24-2ba2-7000-8000-000000000001',
          phoneE164: '+8613800138000',
          signName: '平台通知',
          templateCode: 'SMS_123456',
          variables: {},
          sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
          sendDate: '20260914',
        })
        .catch((error: unknown) => {
          failure = error;
        });
      await vi.advanceTimersByTimeAsync(100);
      expect(failure).toMatchObject({ kind: 'TRANSIENT', code: 'ALIYUN_QUERY_TIMEOUT' });
      expect(
        (querySendDetails.mock.calls[0]?.[1] as { signal?: AbortSignal }).signal?.aborted,
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies one hard deadline across the entire multi-page reconciliation', async () => {
    vi.useFakeTimers();
    try {
      const querySendDetails = vi.fn(
        (_request: unknown, options?: { signal?: AbortSignal }) =>
          new Promise<{ body: Record<string, unknown> }>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve({
                body: {
                  code: 'OK',
                  requestId: 'query-slow',
                  totalCount: '2',
                  smsSendDetailDTOs: {
                    smsSendDetailDTO: [{ outId: 'other', sendStatus: 3 }],
                  },
                },
              });
            }, 60);
            options?.signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }),
      );
      const sender = new AliyunSmsSender(
        { sendSms: vi.fn(), querySendDetails },
        {
          roleArn: 'acs:ram::1:role/sms',
          credentialKmsRef: 'kms://prod/notification/ram-role',
          endpoint: 'dysmsapi.aliyuncs.com',
          approvedSigns: ['平台通知'],
          approvedTemplateCodes: ['SMS_123456'],
        },
        undefined,
        undefined,
        { requestTimeoutMs: 80, reconcileTimeoutMs: 100 },
      );
      let failure: unknown;
      void sender
        .reconcile({
          notificationId: '01990f24-2ba2-7000-8000-000000000001',
          phoneE164: '+8613800138000',
          signName: '平台通知',
          templateCode: 'SMS_123456',
          variables: {},
          sendStartedAt: new Date('2026-09-14T12:00:00.000Z'),
          sendDate: '20260914',
        })
        .catch((error: unknown) => {
          failure = error;
        });
      await vi.advanceTimersByTimeAsync(100);
      expect(failure).toMatchObject({ kind: 'TRANSIENT', code: 'ALIYUN_RECONCILE_TIMEOUT' });
      expect(querySendDetails).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('single-flights expiring RAM credential refresh and retries refresh failure safely', async () => {
    let now = new Date('2026-09-14T12:00:00.000Z');
    const session = (suffix: string, expiresAt: string) => ({
      accessKeyId: `id-${suffix}`,
      accessKeySecret: `secret-${suffix}`,
      securityToken: `token-${suffix}`,
      expiresAt: new Date(expiresAt),
    });
    const resolver = {
      resolve: vi
        .fn()
        .mockResolvedValueOnce(session('one', '2026-09-14T12:02:00.000Z'))
        .mockResolvedValueOnce(session('two', '2026-09-14T13:00:00.000Z')),
    };
    const firstClient = { sendSms: vi.fn(), querySendDetails: vi.fn() };
    const secondClient = {
      sendSms: vi.fn().mockResolvedValue({ body: { code: 'OK' } }),
      querySendDetails: vi.fn(),
    };
    const thirdClient = {
      sendSms: vi.fn().mockResolvedValue({ body: { code: 'OK' } }),
      querySendDetails: vi.fn(),
    };
    const clientFactory = vi
      .fn()
      .mockReturnValueOnce(firstClient)
      .mockReturnValueOnce(secondClient)
      .mockReturnValueOnce(thirdClient);
    const client = new RefreshingAliyunSmsClient(
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
      resolver,
      { now: () => now, refreshBeforeMs: 60_000, clientFactory },
    );
    await client.initialize();
    now = new Date('2026-09-14T12:01:30.000Z');
    await Promise.all(Array.from({ length: 20 }, () => client.sendSms({} as never)));
    expect(resolver.resolve).toHaveBeenCalledTimes(2);
    expect(clientFactory).toHaveBeenCalledTimes(2);
    expect(secondClient.sendSms).toHaveBeenCalledTimes(20);

    now = new Date('2026-09-14T13:00:01.000Z');
    resolver.resolve
      .mockRejectedValueOnce(new Error('secret-value-must-not-leak'))
      .mockResolvedValueOnce(session('three', '2026-09-14T14:00:00.000Z'));
    let refreshError: unknown;
    try {
      await client.sendSms({} as never);
    } catch (error) {
      refreshError = error;
    }
    expect(refreshError).toMatchObject({
      code: 'RAM_CREDENTIAL_REFRESH_FAILED',
      acceptance: 'NOT_ATTEMPTED',
    });
    expect(JSON.stringify(refreshError)).not.toContain('secret-value-must-not-leak');
    await expect(client.sendSms({} as never)).resolves.toBeDefined();
  });

  it('never extends an unchanged SMS STS session and rejects sessions beyond the SDK maximum', async () => {
    let now = new Date('2026-09-14T12:00:00.000Z');
    const expiresAt = new Date(now.getTime() + 2_000);
    const unchanged = {
      accessKeyId: 'id-one',
      accessKeySecret: 'secret-one',
      securityToken: 'token-one',
      expiresAt,
    };
    const resolver = { resolve: vi.fn().mockResolvedValue(unchanged) };
    const raw = {
      ping: vi.fn().mockResolvedValue(undefined),
      sendSms: vi.fn().mockResolvedValue({ body: { code: 'OK' } }),
      querySendDetails: vi.fn(),
    };
    const clientFactory = vi.fn().mockReturnValue(raw);
    const client = new RefreshingAliyunSmsClient(
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
      resolver,
      { now: () => now, refreshBeforeMs: 1_000, clientFactory },
    );
    await client.initialize();
    now = new Date('2026-09-14T12:00:01.500Z');
    await client.ping();
    expect(clientFactory).toHaveBeenCalledOnce();
    now = new Date(expiresAt.getTime() + 1);
    await expect(client.ping()).rejects.toMatchObject({ code: 'RAM_CREDENTIAL_REFRESH_FAILED' });

    const overlong = new RefreshingAliyunSmsClient(
      {
        roleArn: 'acs:ram::1:role/sms',
        credentialKmsRef: 'kms://prod/notification/ram-role',
        endpoint: 'dysmsapi.aliyuncs.com',
        approvedSigns: ['平台通知'],
        approvedTemplateCodes: ['SMS_123456'],
      },
      {
        resolve: () =>
          Promise.resolve({ ...unchanged, expiresAt: new Date(now.getTime() + 3_700_000) }),
      },
      { now: () => now, clientFactory },
    );
    await expect(overlong.initialize()).rejects.toMatchObject({
      code: 'RAM_CREDENTIAL_REFRESH_FAILED',
    });
  });
});
