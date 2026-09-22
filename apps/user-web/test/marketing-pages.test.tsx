import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

  it('keeps maintenance models non-actionable', async () => {
    render(
      await ModelDetailPage({
        params: Promise.resolve({ id: 'seedance-1-5-pro' }),
      }),
    );

    expect(screen.getByRole('heading', { name: 'Seedance 1.5 Pro' })).toBeVisible();
    expect(screen.getByText('按输出规格计费')).toBeVisible();
    expect(screen.queryByRole('link', { name: '使用此模型' })).not.toBeInTheDocument();
    expect(screen.getByText(/暂时无法提交新任务/)).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('模型恢复后才可开始新任务');
  });

  it('offers an active model as a studio action', async () => {
    render(
      await ModelDetailPage({
        params: Promise.resolve({ id: 'kling-2-1-pro' }),
      }),
    );

    expect(screen.getByRole('link', { name: '使用此模型' })).toHaveAttribute(
      'href',
      '/studio?model=kling-2-1-pro',
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

  it('preloads the hero image and preserves mobile navigation tap targets', () => {
    const homeSource = readFileSync(resolve(process.cwd(), 'app/(marketing)/page.tsx'), 'utf8');
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');

    expect(homeSource).toMatch(/<Image[\s\S]*?\bpreload\b[\s\S]*?\/>/);
    expect(homeSource).not.toMatch(/<Image[\s\S]*?\bpriority\b[\s\S]*?\/>/);
    expect(css).toMatch(
      /@media \(max-width: 47\.99rem\)[\s\S]*?\.public-navigation a\s*\{[^}]*display:\s*inline-flex;[^}]*min-height:\s*2\.75rem;[^}]*align-items:\s*center;/,
    );
  });
});
