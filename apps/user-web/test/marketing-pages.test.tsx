import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import HomePage from '../app/(marketing)/page';
import HelpPage from '../app/help/[[...slug]]/page';
import ModelDetailPage from '../app/models/[id]/page';
import PricingPage from '../app/pricing/page';
import { sanitizePublishedHtml } from '../lib/sanitize-published-html';

afterEach(cleanup);

describe('public marketing pages', () => {
  it('keeps the home value proposition, visual and start action in one public shell', async () => {
    render(await HomePage());

    expect(screen.getByRole('heading', { name: '把好模型，变成稳定作品' })).toBeVisible();
    expect(
      screen.getByRole('img', { name: '多层视频画面中的海岸日落，展示 AI 视频创作过程' }),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: '开始创作' })).toHaveAttribute('href', '/studio');
    expect(screen.getByRole('navigation', { name: '公共导航' })).toBeVisible();
  });

  it('renders a model detail from the public Gateway response', async () => {
    render(
      await ModelDetailPage({
        params: Promise.resolve({ id: 'seedance-1-5-pro' }),
      }),
    );

    expect(screen.getByRole('heading', { name: 'Seedance 1.5 Pro' })).toBeVisible();
    expect(screen.getByText('按输出规格计费')).toBeVisible();
    expect(screen.getByRole('link', { name: '使用此模型' })).toHaveAttribute(
      'href',
      '/studio?model=seedance-1-5-pro',
    );
  });

  it('states point conversion and task billing rules without financial promises', async () => {
    render(await PricingPage());

    expect(screen.getByText('1 元 = 100 点数')).toBeVisible();
    expect(screen.getByText(/生成失败/)).toBeVisible();
    expect(screen.getByText(/受理后取消/)).toBeVisible();
  });

  it('sanitizes published help HTML before rendering it', async () => {
    const { container } = render(
      await HelpPage({ params: Promise.resolve({ slug: ['billing', 'refund'] }) }),
    );

    expect(screen.getByRole('heading', { name: '失败退款与取消规则' })).toBeVisible();
    expect(screen.getByText(/失败后，系统会退回/)).toBeVisible();
    expect(container.querySelector('script')).not.toBeInTheDocument();
    expect(container.querySelector('[onclick]')).not.toBeInTheDocument();
  });

  it('does not spread unapproved link attributes through the sanitizer transform', () => {
    const sanitized = sanitizePublishedHtml(
      '<a href="javascript:alert(1)" target="_blank" onclick="steal()" data-private="x">unsafe</a><a href="https://example.com" target="_blank" class="secret">safe</a>',
    );
    const document = new DOMParser().parseFromString(sanitized, 'text/html');
    const [unsafeLink, safeLink] = [...document.querySelectorAll('a')];

    expect(unsafeLink?.hasAttribute('href')).toBe(false);
    expect(unsafeLink?.getAttributeNames()).toEqual(['rel']);
    expect(safeLink?.getAttribute('href')).toBe('https://example.com');
    expect(safeLink?.getAttribute('rel')).toBe('noreferrer noopener');
    expect(safeLink?.getAttributeNames().sort()).toEqual(['href', 'rel']);
  });
});
