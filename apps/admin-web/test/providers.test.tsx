/* eslint-disable @typescript-eslint/require-await -- async fakes model protected provider ports and server actions. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CredentialPanel, ProviderDetailConsole } from '../components/provider-detail-console';
import { ProviderMetadataForm } from '../components/provider-metadata-form';
import {
  createProviderCommandAction,
  createProviderMetadataAction,
  loadProviderDetailView,
  loadProviderDirectoryView,
  parseProviderActionReceipt,
  parseProviderDetailPayload,
  parseProviderDirectoryPayload,
  type ProviderActionReceipt,
  type ProviderMetadataPort,
} from '../lib/provider-operations';
import { signAdminSession } from '../lib/session-auth';

const providerId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const actorId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const auditId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const intentId = '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f';
const signingKey = 'provider-test-signing-key-with-at-least-32-bytes';

const providerRow = {
  circuitState: 'CLOSED',
  health: 'HEALTHY',
  id: providerId,
  latencyP95Ms: 870,
  name: 'Mock Video Provider',
  sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
  status: 'ENABLED',
  successRateBps: 9985,
} as const;

const providerDetailPayload = {
  alert: { channels: ['SLS', 'PHONE'], owner: '视频供应链值班组' },
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
      id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f',
      kmsReference: 'kms://providers/mock/production-key',
      masked: 'sk_****7d2a',
      rotatedAt: '2026-08-28T00:00:00.000Z',
      rotatedBy: actorId,
      scope: ['TASK_CREATE', 'TASK_QUERY'],
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
  maintenanceWindow: {
    endsAt: '2026-09-02T20:00:00.000Z',
    reason: '例行维护',
    startsAt: '2026-09-02T18:00:00.000Z',
  },
  name: 'Mock Video Provider',
  ownerAdminId: actorId,
  procurement: { costUnit: 'PROVIDER_CREDITS', discountBps: 8500 },
  rateLimits: { concurrency: 24, requests: 120, windowSeconds: 60 },
  sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
  status: 'ENABLED',
  successRateBps: 9985,
  version: 7,
} as const;

describe('provider response safety', () => {
  it('strictly parses and deeply freezes provider directory data', () => {
    const parsed = parseProviderDirectoryPayload({
      items: [providerRow],
      partialFields: [],
      sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
    });
    expect(parsed.items[0]).toEqual(providerRow);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.items)).toBe(true);
    expect(Object.isFrozen(parsed.items[0])).toBe(true);
    expect(() =>
      parseProviderDirectoryPayload({
        items: [providerRow],
        partialFields: [],
        sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
        unexpected: true,
      }),
    ).toThrow('供应商目录响应无效');
  });

  it('rejects getters, proxies and every raw secret path', () => {
    const getterPayload = { ...providerDetailPayload } as Record<string, unknown>;
    Object.defineProperty(getterPayload, 'name', { enumerable: true, get: () => 'leaked' });
    expect(() => parseProviderDetailPayload(getterPayload)).toThrow('供应商详情响应无效');
    expect(() => parseProviderDetailPayload(new Proxy({ ...providerDetailPayload }, {}))).toThrow(
      '供应商详情响应无效',
    );
    expect(() =>
      parseProviderDetailPayload({ ...providerDetailPayload, apiKey: 'sk_live_full_secret' }),
    ).toThrow('供应商详情响应无效');
    expect(() =>
      parseProviderDetailPayload({
        ...providerDetailPayload,
        credentials: [{ ...providerDetailPayload.credentials[0], masked: 'sk_live_full_secret' }],
      }),
    ).toThrow('供应商详情响应无效');
    expect(() =>
      parseProviderDetailPayload({
        ...providerDetailPayload,
        credentials: [
          {
            ...providerDetailPayload.credentials[0],
            masked: 'sk_****livefullcredentialmaterial',
          },
        ],
      }),
    ).toThrow('供应商详情响应无效');
  });

  it('rejects stale or contradictory provider command receipts', () => {
    const receipt = {
      auditRecordId: auditId,
      providerId,
      requestId,
      status: 'ENABLED',
      version: 7,
    };
    expect(() =>
      parseProviderActionReceipt(receipt, providerId, {
        kind: 'PROVIDER_DISABLE',
        previousVersion: 7,
      }),
    ).toThrow('供应商操作回执无效');
    expect(() =>
      parseProviderActionReceipt({ ...receipt, status: 'DISABLED', version: 8 }, providerId, {
        kind: 'PROVIDER_DISABLE',
        previousVersion: 7,
      }),
    ).not.toThrow();
  });

  it('never places a full credential in DOM or serialized RSC data', () => {
    const detail = parseProviderDetailPayload(providerDetailPayload);
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('sk_live_full_secret');
    render(
      <CredentialPanel
        canDisable={false}
        canRead
        canRotate={false}
        credentials={detail.credentials}
        providerId={providerId}
        version={7}
      />,
    );
    expect(document.body.textContent).not.toContain('sk_live_full_secret');
    expect(screen.getByText('sk_****7d2a')).toBeVisible();
    expect(screen.queryByRole('button', { name: '轮换凭证' })).not.toBeInTheDocument();
  });
});

describe('provider route authorization and scope', () => {
  it('fails closed before a directory port call without providers:read', async () => {
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['users:read'],
        sessionInstanceId: intentId,
        subjectId: actorId,
      },
      signingKey,
    );
    const listProviders = vi.fn();
    await expect(
      loadProviderDirectoryView({ context: { sessionToken, signingKey }, port: { listProviders } }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(listProviders).not.toHaveBeenCalled();
  });

  it('enforces returned resource scope for provider detail', async () => {
    const sessionToken = await signAdminSession(
      {
        dataScope: 'OWN',
        expiresAt: Date.now() + 60_000,
        permissions: ['providers:read'],
        sessionInstanceId: intentId,
        subjectId: actorId,
      },
      signingKey,
    );
    const outside = {
      ...providerDetailPayload,
      assignedAdminIds: [],
      ownerAdminId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
    };
    await expect(
      loadProviderDetailView(providerId, {
        context: { sessionToken, signingKey },
        port: {
          async getProvider() {
            return outside;
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

describe('provider high-risk operations', () => {
  it('creates provider metadata without accepting credential material', async () => {
    const onSubmit = vi.fn<(formData: FormData) => Promise<ProviderActionReceipt>>(async () => ({
      auditRecordId: auditId,
      ok: true as const,
      providerId,
      requestId,
      status: 'ENABLED' as const,
      version: 1,
    }));
    render(<ProviderMetadataForm actorId={actorId} mode="CREATE" onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText('供应商名称'), {
      target: { value: 'Mock Video Provider' },
    });
    fireEvent.change(screen.getByLabelText('接口地址'), {
      target: { value: 'https://mock-provider.internal/v1' },
    });
    fireEvent.change(screen.getByLabelText('负责人管理员 ID'), { target: { value: actorId } });
    fireEvent.change(screen.getByLabelText('变更原因'), { target: { value: '新增供应商接入' } });
    fireEvent.click(screen.getByLabelText('我确认提交供应商配置'));
    fireEvent.click(screen.getByRole('button', { name: '创建供应商' }));

    await waitFor(() => {
      expect(onSubmit).toHaveBeenCalledTimes(1);
    });
    const submitted = onSubmit.mock.calls[0]?.[0] as FormData;
    expect(Object.fromEntries(submitted)).toMatchObject({
      authMethod: 'API_KEY',
      baseUrl: 'https://mock-provider.internal/v1',
      callbackMode: 'NONE',
      confirmed: 'true',
      kind: 'CREATE',
      name: 'Mock Video Provider',
      ownerAdminId: actorId,
      reason: '新增供应商接入',
    });
    expect([...submitted.keys()]).not.toContain('apiKey');
    expect(screen.queryByLabelText(/密钥|凭证/u)).not.toBeInTheDocument();
  });

  it('allowlists provider metadata and re-authorizes edit scope server-side', async () => {
    const sessionToken = await signAdminSession(
      {
        dataScope: 'OWN',
        expiresAt: Date.now() + 60_000,
        permissions: ['providers:write'],
        sessionInstanceId: intentId,
        subjectId: actorId,
      },
      signingKey,
    );
    const write = vi.fn<ProviderMetadataPort['write']>(async () => ({
      auditRecordId: auditId,
      providerId,
      requestId,
      status: 'ENABLED' as const,
      version: 8,
    }));
    const action = createProviderMetadataAction({
      context: { sessionToken, signingKey },
      detailPort: {
        async getProvider() {
          return providerDetailPayload;
        },
      },
      port: { write },
    });
    const form = new FormData();
    form.set('kind', 'EDIT');
    form.set('providerId', providerId);
    form.set('expectedVersion', '7');
    form.set('intentId', intentId);
    form.set('name', 'Mock Video Provider');
    form.set('baseUrl', 'https://mock-provider.internal/v2');
    form.set('authMethod', 'HMAC_SHA256');
    form.set('callbackMode', 'SIGNED_WEBHOOK');
    form.set('ownerAdminId', actorId);
    form.set('reason', '升级接口版本');
    form.set('confirmed', 'true');
    await expect(action(form)).resolves.toMatchObject({ ok: true, version: 8 });
    expect(write).toHaveBeenCalledTimes(1);
    const written = write.mock.calls[0]?.[0];
    expect(written).toMatchObject({ actorId, expectedVersion: 7, kind: 'EDIT', scope: 'OWN' });
    expect(written?.metadata).toMatchObject({
      baseUrl: 'https://mock-provider.internal/v2',
      name: 'Mock Video Provider',
    });
    form.set('apiKey', 'sk_live_full_secret');
    await expect(action(form)).rejects.toThrow('字段无效');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['OWN', 'CREATE', '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f'],
    ['ASSIGNED', 'CREATE', actorId],
    ['OWN', 'EDIT', '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f'],
    ['ASSIGNED', 'EDIT', actorId],
  ] as const)(
    'rejects target owners outside %s scope for %s metadata',
    async (dataScope, kind, ownerAdminId) => {
      const sessionToken = await signAdminSession(
        {
          dataScope,
          expiresAt: Date.now() + 60_000,
          permissions: ['providers:write'],
          sessionInstanceId: intentId,
          subjectId: actorId,
        },
        signingKey,
      );
      const write = vi.fn<ProviderMetadataPort['write']>();
      const action = createProviderMetadataAction({
        context: { sessionToken, signingKey },
        detailPort: {
          async getProvider() {
            return {
              ...providerDetailPayload,
              ownerAdminId: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f',
            };
          },
        },
        port: { write },
      });
      const form = new FormData();
      form.set('kind', kind);
      if (kind === 'EDIT') {
        form.set('providerId', providerId);
        form.set('expectedVersion', '7');
      }
      form.set('intentId', intentId);
      form.set('name', 'Mock Video Provider');
      form.set('baseUrl', 'https://mock-provider.internal/v2');
      form.set('authMethod', 'HMAC_SHA256');
      form.set('callbackMode', 'SIGNED_WEBHOOK');
      form.set('ownerAdminId', ownerAdminId);
      form.set('reason', '验证目标负责人范围');
      form.set('confirmed', 'true');

      await expect(action(form)).rejects.toThrow(/数据范围|已分配范围/u);
      expect(write).not.toHaveBeenCalled();
    },
  );

  it('requires operation permission, confirmation, bounded reason and authoritative version', async () => {
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
        permissions: ['providers:disable'],
        sessionInstanceId: intentId,
        subjectId: actorId,
      },
      signingKey,
    );
    const execute = vi.fn(async () => ({
      auditRecordId: auditId,
      providerId,
      requestId,
      status: 'DISABLED' as const,
      version: 8,
    }));
    const action = createProviderCommandAction({
      context: { sessionToken, signingKey },
      detailPort: {
        async getProvider() {
          return providerDetailPayload;
        },
      },
      port: { execute },
    });
    const form = new FormData();
    form.set('kind', 'PROVIDER_DISABLE');
    form.set('providerId', providerId);
    form.set('expectedVersion', '7');
    form.set('intentId', intentId);
    await expect(action(form)).rejects.toThrow('原因');
    form.set('reason', '供应商维护');
    await expect(action(form)).rejects.toThrow('确认');
    form.set('confirmed', 'true');
    await expect(action(form)).resolves.toMatchObject({
      auditRecordId: auditId,
      ok: true,
      version: 8,
    });
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        audit: { idempotencyKey: intentId, reason: '供应商维护' },
        expectedVersion: 7,
        kind: 'PROVIDER_DISABLE',
      }),
    );
  });

  it('re-authorizes provider command scope and version before execution', async () => {
    const sessionToken = await signAdminSession(
      {
        dataScope: 'OWN',
        expiresAt: Date.now() + 60_000,
        permissions: ['providers:disable'],
        sessionInstanceId: intentId,
        subjectId: actorId,
      },
      signingKey,
    );
    const execute = vi.fn();
    const outside = {
      ...providerDetailPayload,
      assignedAdminIds: [],
      ownerAdminId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
    };
    const action = createProviderCommandAction({
      context: { sessionToken, signingKey },
      detailPort: {
        async getProvider() {
          return outside;
        },
      },
      port: { execute },
    });
    const form = new FormData();
    form.set('kind', 'PROVIDER_DISABLE');
    form.set('providerId', providerId);
    form.set('expectedVersion', '7');
    form.set('intentId', intentId);
    form.set('reason', '供应商维护');
    form.set('confirmed', 'true');

    await expect(action(form)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(execute).not.toHaveBeenCalled();
  });

  it('clears a replacement secret immediately and keeps it cleared after failure', async () => {
    let rejectRequest: ((error: Error) => void) | undefined;
    const onCommand = vi.fn<(formData: FormData) => Promise<ProviderActionReceipt>>(
      () =>
        new Promise<never>((_resolve, reject) => {
          rejectRequest = reject;
        }),
    );
    const detail = parseProviderDetailPayload(providerDetailPayload);
    render(
      <ProviderDetailConsole
        permissions={['credentials:rotate']}
        provider={detail}
        onCommand={onCommand}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '轮换凭证' }));
    fireEvent.change(screen.getByLabelText('替换密钥'), {
      target: { value: 'sk_live_full_secret' },
    });
    fireEvent.change(screen.getByLabelText('操作原因'), { target: { value: '计划轮换' } });
    fireEvent.click(screen.getByLabelText('我确认执行高风险操作'));
    fireEvent.click(screen.getByRole('button', { name: '确认提交' }));
    expect(screen.getByLabelText('替换密钥')).toHaveValue('');
    const submitted = onCommand.mock.calls[0]?.[0] as FormData;
    expect(submitted.get('replacementSecret')).toBe('sk_live_full_secret');
    rejectRequest?.(new Error('rejected'));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('操作被拒绝或暂时不可用'),
    );
    expect(screen.getByLabelText('替换密钥')).toHaveValue('');
    expect(document.body.textContent).not.toContain('sk_live_full_secret');
  });

  it('renders only actions allowed by the permission matrix', () => {
    const detail = parseProviderDetailPayload(providerDetailPayload);
    render(
      <ProviderDetailConsole
        permissions={['providers:probe', 'providers:circuit-reset']}
        provider={detail}
        onCommand={async () => ({
          auditRecordId: auditId,
          ok: true,
          providerId,
          requestId,
          status: 'ENABLED',
          version: 8,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: '健康探测' })).toBeVisible();
    expect(screen.getByRole('button', { name: '重置熔断' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '停用供应商' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '轮换凭证' })).not.toBeInTheDocument();
  });
});
