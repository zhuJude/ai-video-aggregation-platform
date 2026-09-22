import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdminShell } from '../components/admin-shell';

const subject = {
  permissions: ['overview:read', 'users:read'],
  dataScope: 'ASSIGNED' as const,
};

describe('AdminShell accessibility and mobile context', () => {
  it('renders breadcrumb ancestors as links and the current item as non-action text', () => {
    render(
      <AdminShell
        breadcrumbs={[
          { label: '总览', href: '/overview' },
          { label: '用户', href: '/users' },
          { label: '用户详情', href: '/users/user-9' },
        ]}
        subject={subject}
      >
        {null}
      </AdminShell>,
    );

    const breadcrumbs = screen.getByRole('navigation', { name: '面包屑' });
    expect(within(breadcrumbs).getByRole('link', { name: '总览' })).toHaveAttribute(
      'href',
      '/overview',
    );
    expect(within(breadcrumbs).getByRole('link', { name: '用户' })).toHaveAttribute(
      'href',
      '/users',
    );
    expect(within(breadcrumbs).queryByRole('button', { name: '用户详情' })).toBeNull();
    expect(within(breadcrumbs).getByText('用户详情')).toHaveAttribute('aria-current', 'page');
  });

  it('keeps environment and data-scope context inside the mobile navigation', () => {
    render(
      <AdminShell environment="预发布" subject={subject}>
        {null}
      </AdminShell>,
    );

    const mobileContext = screen.getByRole('region', {
      name: '移动端管理上下文',
    });
    expect(within(mobileContext).getByText('预发布')).toBeVisible();
    expect(within(mobileContext).getByText('数据范围 已分配')).toBeVisible();
    expect(screen.getByRole('complementary')).not.toContainElement(mobileContext);
  });

  it('updates the mobile toggle label to reflect open and closed state', () => {
    render(<AdminShell subject={subject}>{null}</AdminShell>);

    const openButton = screen.getByRole('button', { name: '打开导航' });
    fireEvent.click(openButton);
    const closeButton = screen.getByRole('button', { name: '关闭导航' });
    expect(closeButton).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(closeButton);
    expect(screen.getByRole('button', { name: '打开导航' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('uses combobox and listbox semantics with arrows and Escape handling', () => {
    render(<AdminShell subject={subject}>{null}</AdminShell>);

    const combobox = screen.getByRole('combobox', { name: '命令搜索' });
    expect(combobox).toHaveAttribute('aria-expanded', 'false');

    fireEvent.change(combobox, { target: { value: '用' } });
    expect(combobox).toHaveAttribute('aria-expanded', 'true');
    expect(combobox).toHaveAttribute('aria-controls', 'admin-command-results');
    expect(screen.getByRole('listbox', { name: '命令搜索结果' })).toBeVisible();
    expect(screen.getByRole('option', { name: '用户' })).toBeVisible();

    fireEvent.keyDown(combobox, { key: 'ArrowDown' });
    expect(combobox).toHaveAttribute('aria-activedescendant', 'admin-command-option-0');
    fireEvent.keyDown(combobox, { key: 'Escape' });
    expect(combobox).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
