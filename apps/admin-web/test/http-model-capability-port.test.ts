/* eslint-disable @typescript-eslint/require-await -- async fakes model protected upstream requests. */

import { describe, expect, it, vi } from 'vitest';

import { createHttpModelCapabilityPorts } from '../lib/http-model-capability-port';
import { createOutboundRequestContext } from '../lib/outbound-request-context';

const modelId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const actorId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const intentId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const auditId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const versionId = '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f';
const rollbackTargetVersionId = '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f';
const rollbackReceiptVersionId = '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f';
const context = createOutboundRequestContext(
  () => '00112233445566778899aabbccddeeff',
  () => '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f',
);
const environment = {
  apiUrl: 'https://catalog.internal',
  kmsIdentityReference: 'kms://admin-web/catalog-client',
};
const definition = {
  costDimensions: ['duration'],
  providerMapping: { duration: 'duration_seconds' },
  schema: {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    additionalProperties: false,
    properties: { duration: { enum: [5, 10], type: 'integer' } },
    required: ['duration'],
    type: 'object',
  },
  uiSchema: { fields: [{ label: '时长', name: 'duration', order: 1, unit: '秒' }] },
} as const;

describe('HTTP model capability port', () => {
  it('uses dedicated catalog configuration and records one redacted config failure', () => {
    vi.stubEnv('ADMIN_CATALOG_API_URL', 'https://catalog.internal');
    vi.stubEnv('ADMIN_CATALOG_KMS_IDENTITY_REF', 'kms://admin-web/catalog-client');
    expect(() => createHttpModelCapabilityPorts()).not.toThrow();
    vi.unstubAllEnvs();
    const record = vi.fn();
    expect(() =>
      createHttpModelCapabilityPorts(
        {
          apiUrl: 'http://catalog.internal/sk_live_secret',
          kmsIdentityReference: 'sk_live_secret',
        },
        { telemetry: { record } },
      ),
    ).toThrow('模型目录服务配置无效');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'catalog.config', reason: 'INVALID_CONFIG' }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('sk_live_secret');
  });

  it('sends scoped credential-free GET requests with trace and KMS identity headers', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl =
        input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          items: [],
          partialFields: [],
          sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    });
    const ports = createHttpModelCapabilityPorts(environment, { fetchImpl });
    await ports.directoryPort.listModels({
      requestContext: context,
      scope: 'ASSIGNED',
      trustedSessionToken: 'trusted-session',
    });
    expect(capturedUrl).toBe('https://catalog.internal/v1/admin/models');
    expect(capturedInit?.method).toBe('GET');
    expect(capturedInit?.body).toBeUndefined();
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('X-Admin-Data-Scope')).toBe('ASSIGNED');
    expect(headers.get('X-Admin-Session-Token')).toBe('trusted-session');
    expect(headers.get('X-Service-Identity-Kms-Ref')).toBe(environment.kmsIdentityReference);
    expect(headers.get('X-Trace-ID')).toBe(context.traceId);
  });

  it('posts an exact audited publish command and validates its receipt', async () => {
    let capturedInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      capturedInit = init;
      return new Response(
        JSON.stringify({
          auditRecordId: auditId,
          idempotencyKey: intentId,
          kind: 'PUBLISH',
          modelId,
          requestId,
          sourceVersionId: versionId,
          status: 'PUBLISHED',
          targetVersionId: null,
          version: 8,
          versionId: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f',
        }),
        { headers: { 'Content-Type': 'application/json' }, status: 200 },
      );
    });
    const ports = createHttpModelCapabilityPorts(environment, { fetchImpl });
    const receipt = await ports.commandPort.execute({
      actorId,
      audit: { idempotencyKey: intentId, reason: '发布原因' },
      expectedVersion: 7,
      kind: 'PUBLISH',
      modelId,
      preflightToken: 'pf_abcdefghijklmnopqrstuvwxyz123456',
      requestContext: context,
      scope: 'ALL',
      sourceVersionId: versionId,
      trustedSessionToken: 'trusted-session',
    });
    expect(receipt).toMatchObject({ modelId, ok: true, status: 'PUBLISHED', version: 8 });
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get('Idempotency-Key')).toBe(intentId);
    if (typeof capturedInit?.body !== 'string') throw new Error('expected JSON body');
    expect(JSON.parse(capturedInit.body)).toEqual({
      audit: { actorId, reason: '发布原因' },
      expectedVersion: 7,
      kind: 'PUBLISH',
      preflightToken: 'pf_abcdefghijklmnopqrstuvwxyz123456',
      sourceVersionId: versionId,
    });
  });

  it('uses a dedicated fresh rollback preview and binds its token into the audited command', async () => {
    const requests: Array<{ init: RequestInit | undefined; url: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        input instanceof URL ? input.toString() : typeof input === 'string' ? input : input.url;
      requests.push({ init, url });
      const payload = url.endsWith('/rollback-preview')
        ? {
            diff: '回滚能力定义至 v6',
            expiresAt: '2099-09-12T01:00:00.000Z',
            modelId,
            preflightToken: 'pf_rollback_abcdefghijklmnopqrstuvwxyz',
            sourceVersionId: versionId,
            targetVersionId: rollbackTargetVersionId,
            version: 7,
          }
        : {
            auditRecordId: auditId,
            idempotencyKey: intentId,
            kind: 'ROLLBACK',
            modelId,
            requestId,
            sourceVersionId: versionId,
            status: 'PUBLISHED',
            targetVersionId: rollbackTargetVersionId,
            version: 8,
            versionId: rollbackReceiptVersionId,
          };
      return new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
        status: 200,
      });
    });
    const ports = createHttpModelCapabilityPorts(environment, { fetchImpl });

    await ports.commandPort.previewRollback?.({
      expectedVersion: 7,
      modelId,
      requestContext: context,
      scope: 'ALL',
      sourceVersionId: versionId,
      targetVersionId: rollbackTargetVersionId,
      trustedSessionToken: 'trusted-session',
    });
    await ports.commandPort.execute({
      actorId,
      audit: { idempotencyKey: intentId, reason: '回滚原因' },
      expectedVersion: 7,
      kind: 'ROLLBACK',
      modelId,
      preflightToken: 'pf_rollback_abcdefghijklmnopqrstuvwxyz',
      requestContext: context,
      scope: 'ALL',
      sourceVersionId: versionId,
      targetVersionId: rollbackTargetVersionId,
      trustedSessionToken: 'trusted-session',
    });

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe(
      `https://catalog.internal/v1/admin/models/${modelId}/capabilities/rollback-preview`,
    );
    expect(new Headers(requests[0]?.init?.headers).has('Idempotency-Key')).toBe(false);
    const previewBody = requests[0]?.init?.body;
    if (typeof previewBody !== 'string') throw new Error('expected preview JSON body');
    expect(JSON.parse(previewBody)).toEqual({
      expectedVersion: 7,
      sourceVersionId: versionId,
      targetVersionId: rollbackTargetVersionId,
    });
    expect(new Headers(requests[1]?.init?.headers).get('Idempotency-Key')).toBe(intentId);
    const rollbackBody = requests[1]?.init?.body;
    if (typeof rollbackBody !== 'string') throw new Error('expected rollback JSON body');
    expect(JSON.parse(rollbackBody)).toEqual({
      audit: { actorId, reason: '回滚原因' },
      expectedVersion: 7,
      kind: 'ROLLBACK',
      preflightToken: 'pf_rollback_abcdefghijklmnopqrstuvwxyz',
      sourceVersionId: versionId,
      targetVersionId: rollbackTargetVersionId,
    });
  });

  it('rejects hostile inputs before fetch and emits one safe event for a malformed response', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ extra: 'sk_live_secret' }), {
          headers: { 'Content-Type': 'application/json' },
          status: 200,
        }),
    );
    const record = vi.fn();
    const ports = createHttpModelCapabilityPorts(environment, { fetchImpl, telemetry: { record } });
    await expect(
      ports.directoryPort.listModels(
        new Proxy(
          { requestContext: context, scope: 'ALL', trustedSessionToken: 'trusted-session' },
          {},
        ) as never,
      ),
    ).rejects.toThrow('上下文无效');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      ports.commandPort.execute({
        actorId,
        audit: { idempotencyKey: intentId, reason: '保存草稿' },
        definition: new Proxy(definition, {}) as never,
        expectedVersion: 7,
        kind: 'SAVE',
        modelId,
        requestContext: context,
        scope: 'ALL',
        sourceVersionId: versionId,
        trustedSessionToken: 'trusted-session',
      }),
    ).rejects.toThrow('模型能力响应无效');
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(
      ports.detailPort.getCapability({
        modelId,
        requestContext: context,
        scope: 'ALL',
        trustedSessionToken: 'trusted-session',
      }),
    ).rejects.toThrow();
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'catalog.model.capability-read',
        reason: 'MALFORMED_RESPONSE',
      }),
    );
    expect(JSON.stringify(record.mock.calls)).not.toContain('sk_live_secret');
  });
});
