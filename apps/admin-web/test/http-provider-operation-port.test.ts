/* eslint-disable @typescript-eslint/require-await -- async fakes model protected upstream requests. */

import { describe, expect, it, vi } from 'vitest';

import { createHttpProviderOperationPorts } from '../lib/http-provider-operation-port';
import { createOutboundRequestContext } from '../lib/outbound-request-context';
import { createProviderMetadataAction } from '../lib/provider-operations';
import { signAdminSession } from '../lib/session-auth';

const providerId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const actorId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const credentialId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const auditId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const idempotencyKey = '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f';
const context = createOutboundRequestContext(
  () => '00112233445566778899aabbccddeeff',
  () => '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f',
);

const detail = {
  alert: { channels: ['SLS'], owner: '供应链值班组' },
  assignedAdminIds: [actorId],
  auth: { kmsIdentityReference: 'kms://admin-web/provider-runtime', method: 'HMAC_SHA256' },
  balance: { amount: '9823400', threshold: '1000000', unit: 'PROVIDER_CREDITS' },
  callback: {
    configured: true,
    mode: 'SIGNED_WEBHOOK',
    verificationKmsReference: 'kms://providers/mock/callback',
  },
  circuitState: 'CLOSED',
  credentials: [
    {
      audit: { lastAccessedAt: '2026-08-28T00:00:00.000Z', lastAccessedBy: actorId },
      id: credentialId,
      kmsReference: 'kms://providers/mock/production-key',
      masked: 'sk_****7d2a',
      rotatedAt: '2026-08-28T00:00:00.000Z',
      rotatedBy: actorId,
      scope: ['TASK_CREATE'],
      status: 'ACTIVE',
    },
  ],
  health: 'HEALTHY',
  id: providerId,
  interface: {
    baseUrl: 'https://mock-provider.internal/v1',
    protocol: 'REST_JSON',
    timeoutMs: 5000,
  },
  lastProbe: {
    checkedAt: '2026-08-28T00:00:00.000Z',
    message: 'ready',
    traceId: '00112233445566778899aabbccddeeff',
  },
  latencyP95Ms: 870,
  maintenanceWindow: null,
  name: 'Mock Video Provider',
  ownerAdminId: actorId,
  procurement: { costUnit: 'PROVIDER_CREDITS', discountBps: 8500 },
  rateLimits: { concurrency: 24, requests: 120, windowSeconds: 60 },
  sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
  status: 'ENABLED',
  successRateBps: 9985,
  version: 7,
};

const environment = {
  apiUrl: 'https://operations.internal',
  kmsIdentityReference: 'kms://admin-web/operations-client',
};

describe('HTTP provider operations port', () => {
  it('uses the established operations KMS reference environment variable', () => {
    vi.stubEnv('ADMIN_OPERATIONS_API_URL', 'https://operations.internal');
    vi.stubEnv('ADMIN_OPERATIONS_KMS_IDENTITY_REF', 'kms://admin-web/operations-client');
    vi.stubEnv('ADMIN_OPERATIONS_KMS_IDENTITY_REFERENCE', '');
    expect(() => createHttpProviderOperationPorts()).not.toThrow();
    vi.unstubAllEnvs();
  });

  it.each([
    [
      {
        apiUrl: 'http://operations.internal/sk_live_full_secret',
        kmsIdentityReference: 'kms://admin-web/operations-client',
      },
      undefined,
    ],
    [
      { apiUrl: 'https://operations.internal', kmsIdentityReference: 'sk_live_full_secret' },
      undefined,
    ],
    [environment, 0],
  ] as const)(
    'records one safe config event for invalid configuration %#',
    (invalidEnvironment, deadlineMs) => {
      const record = vi.fn();
      expect(() =>
        createHttpProviderOperationPorts(invalidEnvironment, {
          ...(deadlineMs === undefined ? {} : { deadlineMs }),
          telemetry: { record },
        }),
      ).toThrow('供应商服务配置无效');
      expect(record).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'operations.provider.config',
          reason: 'INVALID_CONFIG',
        }),
      );
      const event = record.mock.calls[0]?.[0] as unknown as Record<string, unknown>;
      expect(Object.keys(event).sort()).toEqual([
        'correlationId',
        'operation',
        'reason',
        'traceId',
      ]);
      expect(JSON.stringify(record.mock.calls)).not.toContain('sk_live_full_secret');
    },
  );

  it.each(['getter', 'proxy'] as const)(
    'rejects %s-backed environment configuration before property access or fetch',
    (kind) => {
      const fetchImpl = vi.fn();
      const apiUrlAccessor = vi.fn(() => 'https://operations.internal');
      const base = {
        kmsIdentityReference: 'kms://admin-web/operations-client',
      } as Record<string, unknown>;
      Object.defineProperty(base, 'apiUrl', { enumerable: true, get: apiUrlAccessor });
      const unsafe = kind === 'proxy' ? new Proxy(base, {}) : base;

      expect(() =>
        createHttpProviderOperationPorts(unsafe as never, {
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).toThrow('供应商服务配置无效');
      expect(apiUrlAccessor).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects non-HTTPS and non-KMS service configuration before fetch', () => {
    const fetchImpl = vi.fn();
    expect(() =>
      createHttpProviderOperationPorts(
        { apiUrl: 'http://operations.internal', kmsIdentityReference: 'raw-secret' },
        { fetchImpl },
      ),
    ).toThrow('供应商服务配置无效');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends trusted headers and no secret in a provider GET', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(detail), { status: 200 }));
    const ports = createHttpProviderOperationPorts(environment, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      ports.detailPort.getProvider({
        providerId,
        requestContext: context,
        scope: 'ALL',
        trustedSessionToken: 'trusted-session',
      }),
    ).resolves.toMatchObject({ id: providerId });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(`https://operations.internal/v1/admin/providers/${providerId}`);
    expect(url.toString()).not.toMatch(/secret|credential|token/iu);
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    const headers = init.headers as Headers;
    expect(headers.get('X-Trace-ID')).toBe(context.traceId);
    expect(headers.get('X-Correlation-ID')).toBe(context.correlationId);
    expect(headers.get('X-Admin-Data-Scope')).toBe('ALL');
    expect(headers.get('X-Service-Identity-Kms-Ref')).toBe(environment.kmsIdentityReference);
  });

  it('fails closed on raw secret responses and emits one safe event with the request context', async () => {
    const record = vi.fn();
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...detail, apiKey: 'sk_live_full_secret' }), { status: 200 }),
    );
    const ports = createHttpProviderOperationPorts(environment, {
      fetchImpl: fetchImpl as typeof fetch,
      telemetry: { record },
    });
    await expect(
      ports.detailPort.getProvider({
        providerId,
        requestContext: context,
        scope: 'ALL',
        trustedSessionToken: 'trusted-session',
      }),
    ).rejects.toThrow('供应商详情响应无效');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      correlationId: context.correlationId,
      operation: 'operations.provider.detail-read',
      reason: 'MALFORMED_RESPONSE',
      traceId: context.traceId,
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain('sk_live_full_secret');
  });

  it('posts a replacement once with stable idempotency and parses only safe receipt metadata', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            auditRecordId: auditId,
            providerId,
            requestId,
            status: 'ENABLED',
            version: 8,
          }),
          { status: 200 },
        ),
    );
    const ports = createHttpProviderOperationPorts(environment, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      ports.commandPort.execute({
        actorId,
        audit: { idempotencyKey, reason: '计划轮换' },
        credentialId,
        expectedVersion: 7,
        kind: 'CREDENTIAL_ROTATE',
        providerId,
        replacementSecret: 'sk_live_full_secret',
        requestContext: context,
        scope: 'OWN',
        trustedSessionToken: 'trusted-session',
      }),
    ).resolves.toMatchObject({ auditRecordId: auditId, version: 8 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      `https://operations.internal/v1/admin/providers/${providerId}/commands`,
    );
    expect(url.toString()).not.toContain('sk_live_full_secret');
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('Idempotency-Key')).toBe(idempotencyKey);
    expect(JSON.parse(init.body as string)).toMatchObject({
      audit: { actorId, reason: '计划轮换' },
      credentialId,
      expectedVersion: 7,
      kind: 'CREDENTIAL_ROTATE',
      replacementSecret: 'sk_live_full_secret',
    });
  });

  it('writes only allowlisted provider metadata without credential material', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            auditRecordId: auditId,
            providerId,
            requestId,
            status: 'ENABLED',
            version: 8,
          }),
          { status: 200 },
        ),
    );
    const ports = createHttpProviderOperationPorts(environment, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      ports.metadataPort.write({
        actorId,
        audit: { idempotencyKey, reason: '更新维护安排' },
        expectedVersion: 7,
        kind: 'EDIT',
        metadata: {
          authMethod: 'HMAC_SHA256',
          baseUrl: 'https://mock-provider.internal/v2',
          callbackMode: 'SIGNED_WEBHOOK',
          maintenanceWindow: null,
          name: 'Mock Video Provider',
          ownerAdminId: actorId,
        },
        providerId,
        requestContext: context,
        scope: 'OWN',
        trustedSessionToken: 'trusted-session',
      }),
    ).resolves.toMatchObject({ providerId, version: 8 });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe(
      `https://operations.internal/v1/admin/providers/${providerId}/metadata`,
    );
    expect((init.headers as Headers).get('X-Admin-Data-Scope')).toBe('OWN');
    expect((init.headers as Headers).get('Idempotency-Key')).toBe(idempotencyKey);
    expect(init.body).not.toContain('secret');
    const parsedBody = JSON.parse(init.body as string) as unknown;
    if (!parsedBody || typeof parsedBody !== 'object') throw new Error('missing metadata body');
    expect(Object.keys(parsedBody).sort()).toEqual(['audit', 'expectedVersion', 'metadata']);
  });

  it('composes the real metadata action and HTTP port without rejecting its safe receipt', async () => {
    const signingKey = 'provider-http-integration-signing-key-at-least-32-bytes';
    const fetchImpl = vi.fn(async (request: URL | RequestInfo, init?: RequestInit) => {
      const url =
        typeof request === 'string'
          ? request
          : request instanceof URL
            ? request.href
            : request.url;
      if (init?.method === 'GET' && url.endsWith(`/v1/admin/providers/${providerId}`))
        return new Response(JSON.stringify(detail), { status: 200 });
      return new Response(
        JSON.stringify({
          auditRecordId: auditId,
          providerId,
          requestId,
          status: 'ENABLED',
          version: 8,
        }),
        { status: 200 },
      );
    });
    const ports = createHttpProviderOperationPorts(environment, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['providers:write'],
        sessionInstanceId: idempotencyKey,
        subjectId: actorId,
      },
      signingKey,
    );
    const action = createProviderMetadataAction({
      context: { sessionToken, signingKey },
      detailPort: ports.detailPort,
      port: ports.metadataPort,
    });
    const form = new FormData();
    form.set('kind', 'EDIT');
    form.set('providerId', providerId);
    form.set('expectedVersion', '7');
    form.set('intentId', idempotencyKey);
    form.set('name', 'Mock Video Provider');
    form.set('baseUrl', 'https://mock-provider.internal/v2');
    form.set('authMethod', 'HMAC_SHA256');
    form.set('callbackMode', 'SIGNED_WEBHOOK');
    form.set('ownerAdminId', actorId);
    form.set('reason', '验证真实端口组合');
    form.set('confirmed', 'true');

    await expect(action(form)).resolves.toMatchObject({ ok: true, version: 8 });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      {
        ...{
          authMethod: 'HMAC_SHA256',
          baseUrl: 'https://mock-provider.internal/v2',
          callbackMode: 'SIGNED_WEBHOOK',
          maintenanceWindow: null,
          name: 'Mock Video Provider',
          ownerAdminId: actorId,
        },
        apiKey: 'sk_live_full_secret',
      },
    ],
    [
      new Proxy(
        {
          authMethod: 'HMAC_SHA256',
          baseUrl: 'https://mock-provider.internal/v2',
          callbackMode: 'SIGNED_WEBHOOK',
          maintenanceWindow: null,
          name: 'Mock Video Provider',
          ownerAdminId: actorId,
        },
        {},
      ),
    ],
    [
      Object.defineProperty(
        {
          authMethod: 'HMAC_SHA256',
          baseUrl: 'https://mock-provider.internal/v2',
          callbackMode: 'SIGNED_WEBHOOK',
          maintenanceWindow: null,
          name: 'Mock Video Provider',
          ownerAdminId: actorId,
        },
        'name',
        { enumerable: true, get: () => 'Mock Video Provider' },
      ),
    ],
    [
      {
        authMethod: 'HMAC_SHA256',
        baseUrl: 'https://mock-provider.internal/v2',
        callbackMode: 'SIGNED_WEBHOOK',
        maintenanceWindow: {
          startsAt: '2026-09-01T00:00:00.000Z',
          endsAt: '2026-09-01T01:00:00.000Z',
          reason: '维护',
          apiKey: 'sk_live_full_secret',
        },
        name: 'Mock Video Provider',
        ownerAdminId: actorId,
      },
    ],
  ])('rejects unsafe metadata before it can leave the process %#', async (metadata) => {
    const fetchImpl = vi.fn();
    const ports = createHttpProviderOperationPorts(environment, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      ports.metadataPort.write({
        actorId,
        audit: { idempotencyKey, reason: '更新配置' },
        expectedVersion: 7,
        kind: 'EDIT',
        metadata: metadata as never,
        providerId,
        requestContext: context,
        scope: 'ALL',
        trustedSessionToken: 'trusted-session',
      }),
    ).rejects.toThrow('供应商元数据上下文无效');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects forged request contexts before network access', async () => {
    const fetchImpl = vi.fn();
    const ports = createHttpProviderOperationPorts(environment, {
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(
      ports.directoryPort.listProviders({
        requestContext: { correlationId: context.correlationId, traceId: context.traceId } as never,
        scope: 'ALL',
        trustedSessionToken: 'trusted-session',
      }),
    ).rejects.toThrow('出站请求上下文无效');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['providerId', 'replacementSecret', 'audit'] as const)(
    'rejects accessor-backed command %s without evaluating it or fetching',
    async (field) => {
      const fetchImpl = vi.fn();
      const ports = createHttpProviderOperationPorts(environment, {
        fetchImpl: fetchImpl as typeof fetch,
      });
      const input: Record<string, unknown> = {
        actorId,
        audit: { idempotencyKey, reason: '计划轮换' },
        credentialId,
        expectedVersion: 7,
        kind: 'CREDENTIAL_ROTATE',
        providerId,
        replacementSecret: 'sk_live_full_secret',
        requestContext: context,
        scope: 'OWN',
        trustedSessionToken: 'trusted-session',
      };
      const original = input[field];
      const accessor = vi.fn(() => original);
      Object.defineProperty(input, field, { enumerable: true, get: accessor });

      await expect(ports.commandPort.execute(input as never)).rejects.toThrow(
        '供应商命令上下文无效',
      );
      expect(accessor).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );
});
