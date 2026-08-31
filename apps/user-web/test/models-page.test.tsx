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
