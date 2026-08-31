import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';

import ModelsPage from '../app/models/page';

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
