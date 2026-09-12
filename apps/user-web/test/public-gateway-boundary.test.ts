import { afterEach, describe, expect, it, vi } from 'vitest';

import { publicSiteGateway } from '../lib/public-gateway';

const previous = {
  gateway: process.env.GATEWAY_URL,
  mode: process.env.USER_WEB_PUBLIC_MODE,
};

afterEach(() => {
  if (previous.gateway === undefined) delete process.env.GATEWAY_URL;
  else process.env.GATEWAY_URL = previous.gateway;
  if (previous.mode === undefined) delete process.env.USER_WEB_PUBLIC_MODE;
  else process.env.USER_WEB_PUBLIC_MODE = previous.mode;
  vi.unstubAllGlobals();
});

describe('public Gateway boundary', () => {
  it('fails closed without a live Gateway and never exposes fixtures implicitly', async () => {
    delete process.env.USER_WEB_PUBLIC_MODE;
    delete process.env.GATEWAY_URL;

    await expect(publicSiteGateway.getHome()).resolves.toMatchObject({
      ok: false,
      error: { code: 'PUBLIC_GATEWAY_UNAVAILABLE' },
    });
  });

  it('enables fixtures only in explicit mock mode and keeps point values lossless', async () => {
    process.env.USER_WEB_PUBLIC_MODE = 'mock';
    const result = await publicSiteGateway.getModel('veo-3-1');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta.transport).toBe('fixture');
    expect(result.data?.pointRange).toEqual({ min: '280', max: '420', unit: '点数' });
  });

  it('uses typed HTTP data in live mode and rejects numeric point fields', async () => {
    delete process.env.USER_WEB_PUBLIC_MODE;
    process.env.GATEWAY_URL = 'https://gateway.example';
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            items: [
              {
                id: 'remote-model',
                displayName: 'Remote',
                provider: { id: 'remote', displayName: 'Remote' },
                modes: ['TEXT_TO_VIDEO'],
                capabilities: [],
                pointRange: { min: 1, max: 2, unit: '点数' },
                speed: '较快',
                qualityLabel: '稳定',
                state: 'ACTIVE',
                stateMessage: '可用',
                publishedDescription: '说明',
                billingRules: [],
              },
            ],
            total: 1,
            filters: {},
            modelOptions: [{ id: 'remote-model', displayName: 'Remote' }],
            providers: [{ id: 'remote', displayName: 'Remote' }],
            capabilities: [],
          }),
          { headers: { 'content-type': 'application/json', 'x-api-version': 'ws09-v1' } },
        ),
      ),
    );

    await expect(publicSiteGateway.getModels({})).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_PUBLIC_GATEWAY_RESPONSE' },
    });
  });

  it('accepts exact live pricing with decimal strings without losing precision', async () => {
    delete process.env.USER_WEB_PUBLIC_MODE;
    process.env.GATEWAY_URL = 'https://gateway.example/base/';
    const gatewayFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          conversion: { currency: 'CNY', amountMinor: '100', points: '100' },
          modelBillingRules: [{ title: '报价', description: '提交前确认' }],
          failureRefundRule: '失败退回',
          acceptedCancellationRule: '受理后按规则取消',
          rechargePackages: [
            {
              id: 'large-package',
              title: '大额点数',
              amountMinor: '900719925474099300',
              points: '900719925474099300',
            },
          ],
        }),
        { headers: { 'content-type': 'application/json', 'x-api-version': 'ws09-v1' } },
      ),
    );
    vi.stubGlobal('fetch', gatewayFetch);

    const result = await publicSiteGateway.getPricing();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta).toEqual({ transport: 'http', version: 'ws09-v1' });
    expect(result.data.rechargePackages?.[0]?.points).toBe('900719925474099300');
    expect(gatewayFetch).toHaveBeenCalledWith(
      new URL('https://gateway.example/v1/public/pricing'),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });
});
