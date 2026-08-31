import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import WorkspaceError from '../app/(workspace)/error';
import WorkspaceLayout from '../app/(workspace)/layout';
import RootLayout from '../app/layout';

afterEach(cleanup);

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

  it('renders workspace navigation inside the workspace route group', () => {
    const markup = renderToStaticMarkup(
      <WorkspaceLayout>
        <main>工作区内容</main>
      </WorkspaceLayout>,
    );

    expect(markup).toContain('工作区内容');
    expect(markup).toContain('开始生成');
    expect(markup).toContain('任务中心');
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
