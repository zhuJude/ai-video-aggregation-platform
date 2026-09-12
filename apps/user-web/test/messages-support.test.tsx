import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageCenter } from '../components/support/message-center';
import { safeMessageDeepLink } from '../lib/support/runtime';
import type { MessagePage, SupportActionResult } from '../lib/support/types';

const page: MessagePage = {
  unreadCount: 2,
  pageInfo: {},
  items: [
    {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7201',
      kind: 'TASK',
      title: '视频已生成',
      summary: '你的作品现在可以预览。',
      occurredAt: '2026-08-31T02:00:00.000Z',
      deepLink: '/tasks/0198f4d4-21c2-7b7d-8a03-08a0da2a7209',
    },
    {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7202',
      kind: 'SYSTEM',
      title: '安全提醒',
      summary: '不要向任何人提供短信验证码。',
      occurredAt: '2026-08-30T02:00:00.000Z',
      deepLink: '/settings/security',
    },
  ],
};

const ok = <T,>(data: T): SupportActionResult<T> => ({ ok: true, data });

afterEach(cleanup);

describe('message center', () => {
  it('allows only explicit app-relative deep links', () => {
    expect(safeMessageDeepLink('/tasks/0198f4d4-21c2-7b7d-8a03-08a0da2a7209')).toBe(
      '/tasks/0198f4d4-21c2-7b7d-8a03-08a0da2a7209',
    );
    expect(safeMessageDeepLink('/wallet?type=REFUND')).toBe('/wallet?type=REFUND');
    for (const unsafe of [
      'https://evil.example',
      '//evil.example/path',
      '/login?returnTo=https://evil.example',
      '/api/private',
      '/tasks/../../settings/security',
      '/%2f%2fevil.example',
      '/tasks\\evil',
    ]) {
      expect(safeMessageDeepLink(unsafe)).toBeUndefined();
    }
  });

  it('updates unread state for one message and in bulk', async () => {
    const user = userEvent.setup();
    const markRead = vi.fn().mockResolvedValue(ok({ readAt: '2026-08-31T03:00:00.000Z' }));
    render(<MessageCenter initial={page} onMarkRead={markRead} />);

    expect(screen.getByText('2 条未读')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '将“视频已生成”标为已读' }));
    expect(screen.getByText('1 条未读')).toBeVisible();
    await user.click(screen.getByRole('button', { name: '将本页标为已读' }));
    expect(screen.getByText('0 条未读')).toBeVisible();
    expect(markRead).toHaveBeenNthCalledWith(1, [page.items[0]?.id], expect.any(String));
    expect(markRead).toHaveBeenNthCalledWith(2, [page.items[1]?.id], expect.any(String));
  });

  it('keeps the global unread total while honestly marking only the current page', async () => {
    const user = userEvent.setup();
    const markRead = vi.fn().mockResolvedValue(ok({ readAt: '2026-08-31T03:00:00.000Z' }));
    render(
      <MessageCenter
        initial={{ ...page, unreadCount: 9, items: page.items.slice(0, 1) }}
        onMarkRead={markRead}
      />,
    );

    expect(screen.getByText('9 条未读')).toBeVisible();
    expect(screen.queryByRole('button', { name: '全部标为已读' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '将本页标为已读' }));
    expect(screen.getByText('8 条未读')).toBeVisible();
    expect(markRead).toHaveBeenCalledWith([page.items[0]?.id], expect.any(String));
  });

  it('disables page marking when the current page has no unread items even if the global total is nonzero', () => {
    render(
      <MessageCenter
        initial={{
          ...page,
          unreadCount: 9,
          items: page.items.map((item) => ({ ...item, readAt: '2026-08-31T03:00:00.000Z' })),
        }}
        onMarkRead={vi.fn()}
      />,
    );

    expect(screen.getByRole('button', { name: '将本页标为已读' })).toBeDisabled();
  });
});
