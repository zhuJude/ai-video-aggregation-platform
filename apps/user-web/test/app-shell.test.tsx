import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppShell, LoadingState, type AppShellUser } from '../components/app-shell';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('AppShell', () => {
  it('shows the primary workspace destinations', () => {
    render(<AppShell user={{ nickname: '小林', points: '1200' }}>{null}</AppShell>);

    for (const label of ['开始生成', '任务中心', '作品素材', '点数钱包']) {
      expect(screen.getByRole('link', { name: label })).toBeVisible();
    }
  });

  it('offers a skip link and labels the main content', () => {
    render(<AppShell>{null}</AppShell>);

    expect(screen.getByRole('link', { name: '跳到主要内容' })).toHaveAttribute(
      'href',
      '#main-content',
    );
    expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  });

  it('shows available and frozen points without exposing a raw user ID', () => {
    const user: AppShellUser & { userId: string } = {
      nickname: '小林',
      points: '1200',
      frozenPoints: '80',
      userId: 'usr_secret_123',
    };

    render(<AppShell user={user}>{null}</AppShell>);

    expect(screen.getByText('可用点数')).toBeVisible();
    expect(screen.getByText('1,200')).toBeVisible();
    expect(screen.getByText('冻结点数')).toBeVisible();
    expect(screen.getByText('80')).toBeVisible();
    expect(screen.queryByText('usr_secret_123')).not.toBeInTheDocument();
  });

  it('provides explicit empty and loading states', () => {
    const { rerender } = render(<AppShell>{null}</AppShell>);

    expect(screen.getByRole('status', { name: '暂无内容' })).toBeVisible();

    rerender(
      <AppShell>
        <LoadingState label="正在加载任务" />
      </AppShell>,
    );

    expect(screen.getByRole('status')).toHaveTextContent('正在加载任务');
  });

  it('contains render errors and announces a recovery action', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    function BrokenContent(): never {
      throw new Error('render failed');
    }

    render(
      <AppShell>
        <BrokenContent />
      </AppShell>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('页面暂时无法显示');
    expect(screen.getByRole('button', { name: '重新加载' })).toBeVisible();
    consoleError.mockRestore();
  });
});
