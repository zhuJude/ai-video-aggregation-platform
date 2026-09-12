import { afterEach, describe, expect, it, vi } from 'vitest';

import { publicSiteGateway } from '../lib/public-gateway';

const previous = {
  gateway: process.env.GATEWAY_URL,
  mode: process.env.USER_WEB_PUBLIC_MODE,
};

function requestPath(input: URL | RequestInfo): string {
  return new URL(input instanceof Request ? input.url : input).pathname;
}

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

  it('uses the WS11 model-list contract without requiring invented response headers', async () => {
    delete process.env.USER_WEB_PUBLIC_MODE;
    process.env.GATEWAY_URL = 'https://gateway.example';
    const gatewayFetch = vi.fn().mockResolvedValue(
      Response.json({
        items: [
          {
            id: '01999d31-f7a3-7c50-98ae-04a08e875402',
            providerId: '01999d31-f7a3-7c50-98ae-04a08e875401',
            providerCode: 'kling',
            providerDisplayName: '可灵 AI',
            code: 'kling-2-1-pro',
            displayName: 'Kling 2.1 Pro',
            modes: ['TEXT_TO_VIDEO'],
            status: 'ACTIVE',
            sortOrder: 1,
            capabilityVersionId: '01999d31-f7a3-7c50-98ae-04a08e875403',
          },
        ],
      }),
    );
    vi.stubGlobal('fetch', gatewayFetch);

    const result = await publicSiteGateway.getModels({
      providerId: '01999d31-f7a3-7c50-98ae-04a08e875401',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.meta).toEqual({ transport: 'http', version: 'v1' });
    expect(result.data.items[0]).toMatchObject({
      id: '01999d31-f7a3-7c50-98ae-04a08e875402',
      provider: { id: '01999d31-f7a3-7c50-98ae-04a08e875401', displayName: '可灵 AI' },
      pointRange: null,
      publishedDescription: null,
    });
    expect(gatewayFetch).toHaveBeenCalledWith(
      new URL('https://gateway.example/v1/models'),
      expect.objectContaining({ cache: 'no-store' }),
    );
  });

  it('maps WS14 recharge packages losslessly and rejects numeric bigint fields', async () => {
    delete process.env.USER_WEB_PUBLIC_MODE;
    process.env.GATEWAY_URL = 'https://gateway.example/base/';
    const gatewayFetch = vi.fn().mockResolvedValue(
      Response.json([
        {
          id: '01990f24-2ba2-7000-8000-000000000001',
          packageId: '01990f24-2ba2-7000-8000-000000000002',
          version: 1,
          revision: 2,
          status: 'PUBLISHED',
          basePublishedVersionId: null,
          name: '大额点数',
          amountMinor: '900719925474099300',
          currency: 'CNY',
          points: '900719925474099300',
          bonusPoints: '7',
          purchaseLimit: null,
          validityDays: null,
          sortOrder: 0,
          activeFrom: null,
          activeUntil: null,
          createdBy: '01990f24-2ba2-7000-8000-000000000003',
          createdAt: '2026-09-01T00:00:00.000Z',
          publishedAt: '2026-09-02T00:00:00.000Z',
          retiredAt: null,
          active: true,
        },
      ]),
    );
    vi.stubGlobal('fetch', gatewayFetch);

    const result = await publicSiteGateway.getPricing();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversion).toBeNull();
    expect(result.data.rechargePackages?.[0]?.points).toBe('900719925474099307');
    expect(gatewayFetch).toHaveBeenCalledWith(
      new URL('https://gateway.example/v1/recharge-packages'),
      expect.objectContaining({ cache: 'no-store' }),
    );

    gatewayFetch.mockResolvedValueOnce(Response.json([{ amountMinor: 1 }]));
    await expect(publicSiteGateway.getPricing()).resolves.toMatchObject({
      ok: false,
      error: { code: 'INVALID_PUBLIC_GATEWAY_RESPONSE' },
    });
  });

  it('maps WS14 help ids to navigable slugs and reads the home banner slot', async () => {
    delete process.env.USER_WEB_PUBLIC_MODE;
    process.env.GATEWAY_URL = 'https://gateway.example';
    const content = {
      id: '01990f24-2ba2-7000-8000-000000000010',
      entryId: '01990f24-2ba2-7000-8000-000000000011',
      version: 1,
      revision: 1,
      status: 'PUBLISHED',
      basePublishedVersionId: null,
      title: '开始使用',
      summary: '了解生成流程',
      bodyHtml: '<p>先确认报价。</p>',
      sortOrder: 0,
      activeFrom: null,
      activeUntil: null,
      helpCategoryId: null,
      createdBy: '01990f24-2ba2-7000-8000-000000000012',
      createdAt: '2026-09-01T00:00:00.000Z',
      publishedAt: '2026-09-02T00:00:00.000Z',
      retiredAt: null,
    };
    const modelResponse = { items: [] };
    const gatewayFetch = vi.fn((input: URL | RequestInfo) => {
      const path = requestPath(input);
      if (path === '/v1/help') return Promise.resolve(Response.json([content]));
      if (path === '/v1/models') return Promise.resolve(Response.json(modelResponse));
      if (path === '/v1/banners/HOME_HERO') {
        return Promise.resolve(
          Response.json([
            {
              placement: {
                id: '01990f24-2ba2-7000-8000-000000000013',
                contentVersionId: content.id,
                slot: 'HOME_HERO',
                sortOrder: 0,
                activeFrom: null,
                activeUntil: null,
                createdBy: content.createdBy,
                createdAt: content.createdAt,
              },
              content,
            },
          ]),
        );
      }
      return Promise.reject(new Error(`unexpected path ${path}`));
    });
    vi.stubGlobal('fetch', gatewayFetch);

    const help = await publicSiteGateway.getHelp([content.id]);
    expect(help.ok && help.data.article).toMatchObject({
      slug: [content.id],
      title: '开始使用',
      kind: 'HELP',
    });
    const home = await publicSiteGateway.getHome();
    expect(home.ok && home.data.creatorCases).toEqual([
      {
        id: content.id,
        title: content.title,
        summary: content.summary,
        category: null,
        modelId: null,
      },
    ]);
    expect(gatewayFetch.mock.calls.map(([input]) => requestPath(input))).toContain(
      '/v1/banners/HOME_HERO',
    );
  });
});
