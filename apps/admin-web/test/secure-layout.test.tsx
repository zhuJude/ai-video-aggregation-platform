import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderSecureLayout } from '../app/(secure)/layout';
import { signAdminSession } from '../lib/session-auth';

const signingKey = 'secure-layout-signing-key-at-least-32-bytes';
const subjectId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';

describe('production secure layout', () => {
  it('mounts the permission-aware shell from verified server claims for every secure child route', async () => {
    const sessionToken = await signAdminSession(
      {
        dataScope: 'OWN',
        expiresAt: Date.now() + 60_000,
        permissions: ['users:read'],
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        subjectId,
      },
      signingKey,
    );
    const { container } = render(
      await renderSecureLayout(<h1>用户生产页面</h1>, { sessionToken, signingKey }),
    );

    expect(screen.getByTestId('admin-shell')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '用户' })).toHaveAttribute('href', '/users');
    expect(screen.queryByRole('link', { name: '总览' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '财务' })).not.toBeInTheDocument();
    expect(screen.getAllByText('数据范围 本人负责')).toHaveLength(2);
    expect(screen.getAllByText(`管理员 ${subjectId}`)).toHaveLength(2);
    expect(screen.getByRole('combobox', { name: '命令搜索' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: '面包屑' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '用户生产页面' })).toBeVisible();
    expect(container.innerHTML).not.toContain(sessionToken);
    expect(container.innerHTML).not.toContain(signingKey);
  });

  it('fails closed before rendering secure children when the trusted session is absent', async () => {
    await expect(
      renderSecureLayout(<div>不得泄漏</div>, { sessionToken: undefined, signingKey }),
    ).rejects.toMatchObject({ code: 'UNAUTHENTICATED' });
  });
});
