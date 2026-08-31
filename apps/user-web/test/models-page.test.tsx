import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import ModelsPage from '../app/models/page';
import { publicSiteGateway, type GatewayResult } from '../lib/public-gateway';

afterEach(cleanup);

it('shows capability, point price and maintenance state', async () => {
  render(await ModelsPage({ searchParams: Promise.resolve({ mode: 'IMAGE_TO_VIDEO' }) }));
  expect(screen.getByText('图生视频')).toBeVisible();
  expect(screen.getByText(/点数/)).toBeVisible();
  expect(screen.getByText('维护中')).toHaveAttribute('data-tone', 'warning');
});

it('filters the catalog by model and exposes stable model options', async () => {
  render(await ModelsPage({ searchParams: Promise.resolve({ model: 'veo-3-1' }) }));

  expect(screen.getByRole('heading', { name: 'Veo 3.1' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Kling 2.1 Pro' })).not.toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Seedance 1.5 Pro' })).not.toBeInTheDocument();

  const modelFilter = screen.getByRole('combobox', { name: '模型' });
  expect(modelFilter).toHaveValue('veo-3-1');
  expect(screen.getByRole('option', { name: 'Veo 3.1' })).toBeVisible();
});

it('keeps Gateway success metadata transport-neutral while the fixture identifies itself', async () => {
  const fixtureResult = await publicSiteGateway.getHome();
  expect(fixtureResult.ok && fixtureResult.meta.transport).toBe('fixture');

  const httpResult: GatewayResult<{ id: string }> = {
    ok: true,
    data: { id: 'remote-model' },
    meta: { transport: 'http', version: 'ws09-v1' },
  };
  expect(httpResult.meta.transport).toBe('http');
});

it('partitions current models into mutually exclusive starting-point bands', async () => {
  const prices = ['UNDER_150', '150_TO_300', 'OVER_300'] as const;
  const results = await Promise.all(prices.map((price) => publicSiteGateway.getModels({ price })));
  const bucketIds = results.flatMap((result) =>
    result.ok ? result.data.items.map((model) => model.id) : [],
  );

  expect([...new Set(bucketIds)].sort()).toEqual(bucketIds.slice().sort());
  expect(bucketIds.slice().sort()).toEqual(['kling-2-1-pro', 'seedance-1-5-pro', 'veo-3-1'].sort());
});

it('uses the first supported value from array query parameters and ignores unknown keys', async () => {
  render(
    await ModelsPage({
      searchParams: Promise.resolve({
        model: ['veo-3-1', 'kling-2-1-pro'],
        unknown: 'ignored',
      }),
    }),
  );

  expect(screen.getByRole('heading', { name: 'Veo 3.1' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Kling 2.1 Pro' })).not.toBeInTheDocument();
});
