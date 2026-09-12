import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import WorkspaceError from '../app/(workspace)/error';
import WorkspaceLayout from '../app/(workspace)/layout';
import RootLayout from '../app/layout';

const readShellUser = vi.hoisted(() => vi.fn());
vi.mock('../lib/workspace-shell', () => ({ readWorkspaceShellUser: readShellUser }));

afterEach(cleanup);
beforeEach(() => {
  readShellUser.mockReset();
  readShellUser.mockResolvedValue(null);
});

describe('route layouts', () => {
  it('keeps workspace navigation out of the public root layout', () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main>公开内容</main>
      </RootLayout>,
    );

    expect(markup).toContain('公开内容');
    expect(markup).not.toContain('开始生成');
  });

  it('renders workspace navigation inside the workspace route group', async () => {
    const markup = renderToStaticMarkup(
      await WorkspaceLayout({ children: <main>工作区内容</main> }),
    );

    expect(markup).toContain('工作区内容');
    expect(markup).toContain('开始生成');
    expect(markup).toContain('任务中心');
  });

  it('hydrates the shell with the authenticated owner profile and wallet summary', async () => {
    readShellUser.mockResolvedValue({
      nickname: '小林',
      points: '9007199254740993',
      frozenPoints: '80',
    });

    const markup = renderToStaticMarkup(await WorkspaceLayout({ children: <p>已登录</p> }));

    expect(markup).toContain('小林');
    expect(markup).toContain('9,007,199,254,740,993');
    expect(markup).not.toContain('登录后查看点数');
  });

  it('lets a user retry a failed workspace route without exposing internals', () => {
    const reset = vi.fn();

    render(<WorkspaceError error={new Error('internal provider credentials')} reset={reset} />);

    expect(screen.getByRole('alert')).toHaveTextContent('工作区暂时无法显示');
    expect(screen.queryByText('internal provider credentials')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(reset).toHaveBeenCalledOnce();
  });

  it('keeps a persistent non-color cue on inline links', () => {
    const css = readFileSync(resolve(process.cwd(), 'app/globals.css'), 'utf8');

    expect(css).toMatch(
      /a\s*\{[^}]*color:\s*var\(--color-accent\);[^}]*text-decoration:\s*underline;/s,
    );
    expect(css).toMatch(
      /\.skip-link,\s*\.brand,\s*\.sign-in-link,\s*\.primary-navigation a\s*\{[^}]*text-decoration:\s*none;/s,
    );
  });
});
