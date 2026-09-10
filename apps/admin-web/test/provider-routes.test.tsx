/* eslint-disable @typescript-eslint/require-await -- async fakes model protected route data ports. */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import ProvidersLoading from '../app/(secure)/providers/loading';
import { renderProvidersPage } from '../app/(secure)/providers/page';
import { renderProviderDetailRoute } from '../app/(secure)/providers/[id]/page';
import { signAdminSession } from '../lib/session-auth';

const providerId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const actorId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const sessionInstanceId = '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f';
const signingKey = 'provider-route-signing-key-with-at-least-32-bytes';
const row = {
  circuitState: 'CLOSED',
  health: 'HEALTHY',
  id: providerId,
  latencyP95Ms: 870,
  name: 'Mock Video Provider',
  sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
  status: 'ENABLED',
  successRateBps: 9985,
} as const;
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
      id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f',
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
} as const;

async function context(
  permissions: readonly (
    | 'credentials:disable'
    | 'credentials:read'
    | 'credentials:rotate'
    | 'providers:read'
    | 'providers:write'
  )[] = ['providers:read'],
  dataScope: 'ALL' | 'ASSIGNED' | 'OWN' = 'ALL',
) {
  const sessionToken = await signAdminSession(
    {
      dataScope,
      expiresAt: Date.now() + 60_000,
      permissions,
      sessionInstanceId,
      subjectId: actorId,
    },
    signingKey,
  );
  return { sessionToken, signingKey };
}

describe('provider routes', () => {
  it('renders accessible loading, empty and partial states', async () => {
    const { rerender } = render(<ProvidersLoading />);
    expect(screen.getByRole('status')).toHaveTextContent('正在载入供应商');
    rerender(
      await renderProvidersPage({
        context: await context(),
        port: {
          async listProviders() {
            return { items: [], partialFields: [], sourceUpdatedAt: '2026-08-28T00:00:00.000Z' };
          },
        },
      }),
    );
    expect(screen.getByText('暂无供应商')).toBeVisible();
    rerender(
      await renderProvidersPage({
        context: await context(),
        port: {
          async listProviders() {
            return {
              items: [row],
              partialFields: ['balance'],
              sourceUpdatedAt: '2026-08-28T00:00:00.000Z',
            };
          },
        },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('部分指标暂不可用');
    expect(screen.getByRole('link', { name: 'Mock Video Provider' })).toHaveAttribute(
      'href',
      `/providers/${providerId}`,
    );
  });

  it('does not render an impossible create flow for ASSIGNED data scope', async () => {
    render(
      await renderProvidersPage({
        context: await context(['providers:read', 'providers:write'], 'ASSIGNED'),
        port: {
          async listProviders() {
            return { items: [], partialFields: [], sourceUpdatedAt: '2026-08-28T00:00:00.000Z' };
          },
        },
      }),
    );
    expect(screen.queryByRole('button', { name: '创建供应商' })).not.toBeInTheDocument();
  });

  it('renders the detail operational console from an authorized server loader', async () => {
    const element = await renderProviderDetailRoute(providerId, {
      context: await context(),
      port: {
        async getProvider() {
          return detail;
        },
      },
    });
    expect(
      (element.props as { provider: { credentials: readonly unknown[] } }).provider.credentials,
    ).toEqual([]);
    render(element);
    expect(screen.getByRole('heading', { name: 'Mock Video Provider' })).toBeVisible();
    expect(screen.getByRole('region', { name: '健康与限额' })).toBeVisible();
    expect(document.body.textContent).not.toMatch(/full.secret/iu);
  });

  it('passes masked credential metadata to the client only with credentials:read', async () => {
    const element = await renderProviderDetailRoute(providerId, {
      context: await context(['providers:read', 'credentials:read']),
      port: {
        async getProvider() {
          return detail;
        },
      },
    });
    const clientProvider = (
      element.props as { provider: { credentials: readonly { masked: string }[] } }
    ).provider;
    expect(clientProvider.credentials).toHaveLength(1);
    expect(clientProvider.credentials[0]?.masked).toBe('sk_****7d2a');
    expect(JSON.stringify(clientProvider)).not.toContain('sk_live_full_secret');
  });

  it('projects only an operation-safe credential summary for rotate-only roles', async () => {
    const element = await renderProviderDetailRoute(providerId, {
      context: await context(['providers:read', 'credentials:rotate']),
      port: {
        async getProvider() {
          return detail;
        },
      },
    });
    const clientProvider = (
      element.props as {
        provider: { credentials: readonly Record<string, unknown>[] };
      }
    ).provider;
    expect(clientProvider.credentials).toEqual([
      {
        id: detail.credentials[0].id,
        label: '凭证 1',
        status: 'ACTIVE',
      },
    ]);
    expect(JSON.stringify(clientProvider.credentials)).not.toMatch(/kms|masked|audit|rotated/iu);
    render(element);
    expect(screen.getByRole('button', { name: '轮换凭证' })).toBeVisible();
    expect(document.body.textContent).not.toContain(detail.credentials[0].kmsReference);
  });
});
