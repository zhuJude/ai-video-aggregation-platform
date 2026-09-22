import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type * as UserViewLoadersModule from '../lib/user-view-loaders';

const mocks = vi.hoisted(() => ({ loadUsersView: vi.fn() }));

vi.mock('../lib/user-view-loaders', async (importOriginal) => {
  const actual = await importOriginal<typeof UserViewLoadersModule>();
  return {
    ...actual,
    REGISTRATION_SOURCES: ['WEB'],
    SPENDING_TIERS: ['HIGH'],
    USER_STATUSES: ['ACTIVE', 'SUSPENDED', 'CLOSED'],
    loadUsersView: mocks.loadUsersView,
  };
});
vi.mock('../lib/http-user-operation-port', () => ({
  createHttpUserOperationPorts: () => ({ directoryPort: {} }),
}));
vi.mock('../app/(secure)/users/actions', () => ({
  lookupExactPhoneAction: vi.fn(),
  requestUsersCsvExportAction: vi.fn(),
}));

import UsersPage from '../app/(secure)/users/page';

const baseView = {
  canExport: false,
  canUseExactPhone: false,
  filters: {},
  items: [],
  nextCursor: null,
};

describe('UsersPage exact-phone privacy boundary', () => {
  it('never echoes a phone-shaped GET query and directs the actor to the protected lookup', async () => {
    mocks.loadUsersView.mockResolvedValue({ ...baseView, canUseExactPhone: true });
    const { container } = render(
      await UsersPage({
        searchParams: Promise.resolve({ exactPhone: 'true', query: '13800138000' }),
      }),
    );

    expect(container.innerHTML).not.toContain('13800138000');
    expect(screen.getByRole('alert')).toHaveTextContent('请使用受保护的精确手机号查询');
    expect(screen.getByRole('textbox', { name: /用户名/u })).toHaveValue('');
    expect(screen.getByRole('textbox', { name: '精确手机号' })).toHaveValue('');
    expect(mocks.loadUsersView).toHaveBeenCalledWith(
      { filters: {}, query: '' },
      expect.any(Object),
    );
  });

  it.each([
    { cursor: 'prefix-13800138000' },
    { status: '+86 138-0013-8000' },
    { tag: 'member-13800138000' },
    { future: '１３８００１３８０００' },
  ])(
    'sanitizes sensitive values from every known or future search parameter before rendering or loading',
    async (searchParams) => {
      mocks.loadUsersView.mockResolvedValue(baseView);
      const { container } = render(
        await UsersPage({ searchParams: Promise.resolve(searchParams) }),
      );
      expect(container.innerHTML).not.toMatch(/13800138000|１３８００１３８０００/u);
      expect(screen.getByRole('alert')).toHaveTextContent('敏感查询参数已移除');
      expect(mocks.loadUsersView).toHaveBeenCalledWith(
        { filters: {}, query: '' },
        expect.any(Object),
      );
    },
  );

  it('does not expose the protected exact lookup to an unauthorized actor', async () => {
    mocks.loadUsersView.mockResolvedValue(baseView);
    render(await UsersPage({ searchParams: Promise.resolve({ query: 'member' }) }));
    expect(screen.queryByRole('textbox', { name: '精确手机号' })).not.toBeInTheDocument();
  });

  it('keeps ordinary pagination URLs free of exact-phone flags and renders frozen statuses', async () => {
    mocks.loadUsersView.mockResolvedValue({
      ...baseView,
      items: [
        {
          displayName: '已关闭用户',
          id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
          phoneMasked: '138****8000',
          status: 'CLOSED',
        },
      ],
      nextCursor: 'next_1',
    });
    render(await UsersPage({ searchParams: Promise.resolve({ query: 'member' }) }));

    const statusFilter = screen.getByRole('combobox', { name: '账户状态' });
    expect(statusFilter).toHaveTextContent('ACTIVE');
    expect(statusFilter).toHaveTextContent('SUSPENDED');
    expect(statusFilter).toHaveTextContent('CLOSED');
    expect(statusFilter).not.toHaveTextContent('PENDING');
    const next = screen.getByRole('link', { name: '下一页' });
    expect(next).toHaveAttribute('href', expect.stringContaining('query=member'));
    expect(next.getAttribute('href')).not.toContain('exactPhone');
    expect(screen.getByRole('cell', { name: '138****8000' })).toBeInTheDocument();
  });
});
