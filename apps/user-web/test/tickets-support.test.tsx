import '@testing-library/jest-dom/vitest';

import { randomBytes } from 'node:crypto';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TicketCenter } from '../components/support/ticket-center';
import { commerceGateway } from '../lib/commerce/gateway';
import { ensureMockSeedObjects } from '../lib/commerce/mock-object-store';
import { supportGateway } from '../lib/support/gateway';
import { parseTicketPage } from '../lib/support/runtime';
import type { TicketPage } from '../lib/support/types';
import { createUuidV7 } from '../lib/tasks/identifiers';
import { createMockStoreTestScope } from './mock-store-scope';

const page: TicketPage = {
  pageInfo: {},
  items: [
    {
      id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7301',
      subject: '任务结果无法播放',
      category: 'TASK',
      status: 'IN_PROGRESS',
      createdAt: '2026-08-30T02:00:00.000Z',
      updatedAt: '2026-08-31T02:00:00.000Z',
      replies: [
        {
          id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7302',
          author: 'USER',
          body: '页面提示文件不可用。',
          createdAt: '2026-08-30T02:00:00.000Z',
          attachments: [
            {
              id: '0198f4d4-21c2-7b7d-8a03-08a0da2a7303',
              name: '错误截图.png',
              mimeType: 'image/png',
              sizeBytes: '1024',
            },
          ],
        },
      ],
      statusHistory: [
        {
          status: 'OPEN',
          occurredAt: '2026-08-30T02:00:00.000Z',
          label: '工单已创建',
        },
        {
          status: 'IN_PROGRESS',
          occurredAt: '2026-08-31T02:00:00.000Z',
          label: '客服处理中',
        },
      ],
      canClose: true,
      canReopen: false,
    },
  ],
};
const mockStoreScope = createMockStoreTestScope();

beforeEach(() => {
  mockStoreScope.install();
  process.env.USER_WEB_SUPPORT_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = randomBytes(32).toString('base64url');
});

afterEach(() => {
  cleanup();
  delete process.env.USER_WEB_SUPPORT_MODE;
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
  delete process.env.USER_WEB_COMMERCE_MOCK_TEST_NAMESPACE;
});

afterAll(async () => {
  await mockStoreScope.cleanup();
});

describe('ticket center', () => {
  it('rejects internal notes and keeps attachments outside public reply text', () => {
    expect(() =>
      parseTicketPage({
        ...page,
        items: [
          {
            ...page.items[0],
            internalNotes: [{ body: '用户不可见的补偿审批' }],
          },
        ],
      }),
    ).toThrow('INVALID_TICKET');

    render(<TicketCenter initial={page} />);
    const reply = screen.getByText('页面提示文件不可用。').closest('article');
    expect(reply).not.toBeNull();
    expect(withinReply(reply as HTMLElement, '错误截图.png')).toBe(true);
    expect(screen.queryByText('用户不可见的补偿审批')).toBeNull();
  });

  it('locks an uncertain create result so repeated clicks cannot duplicate a ticket', async () => {
    const user = userEvent.setup();
    const createTicket = vi.fn().mockResolvedValue({ ok: false, outcome: 'UNCERTAIN' });
    render(<TicketCenter initial={{ items: [], pageInfo: {} }} onCreateTicket={createTicket} />);

    await user.click(screen.getByRole('button', { name: '创建新工单' }));
    await user.type(screen.getByLabelText('工单标题'), '生成任务结果异常');
    await user.type(screen.getByLabelText('问题描述'), '任务显示成功，但结果页面无法播放。');
    await user.click(screen.getByRole('button', { name: '提交工单' }));
    await user.click(screen.getByRole('button', { name: '提交工单' }));

    expect(createTicket).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent('结果待确认');
    expect(screen.getByRole('link', { name: '刷新工单列表核对' })).toHaveAttribute(
      'href',
      '/tickets',
    );
  });

  it('binds attachments to their owner and makes a repeated key idempotent', async () => {
    const ownerId = createUuidV7();
    const attachmentId = createUuidV7();
    await ensureMockSeedObjects(ownerId, [
      {
        assetId: attachmentId,
        kind: 'UPLOAD',
        name: '故障截图.png',
        mimeType: 'image/png',
        createdAt: new Date().toISOString(),
        bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      },
    ]);
    const key = createUuidV7();
    const input = {
      subject: '任务附件边界验证',
      category: 'TASK' as const,
      body: '附件必须与当前账号绑定，并与公开正文分离。',
      attachmentIds: [attachmentId],
    };
    const first = await supportGateway.createTicket(input, { ownerId, idempotencyKey: key });
    await commerceGateway.deleteAsset(attachmentId, {
      ownerId,
      idempotencyKey: createUuidV7(),
    });
    await expect(
      supportGateway.createTicket(input, { ownerId, idempotencyKey: key }),
    ).resolves.toEqual(first);
    const parsed = parseTicketPage({ items: [first], pageInfo: {} }).items[0];
    expect(parsed?.replies[0]?.attachments[0]?.id).toBe(attachmentId);
    await expect(
      supportGateway.createTicket(input, {
        ownerId: createUuidV7(),
        idempotencyKey: createUuidV7(),
      }),
    ).rejects.toThrow('ATTACHMENT_NOT_FOUND');
  });
});

function withinReply(reply: HTMLElement, text: string): boolean {
  const attachment = Array.from(reply.querySelectorAll('[data-ticket-attachment]')).find((node) =>
    node.textContent.includes(text),
  );
  const replyBody = reply.querySelector('[data-ticket-body]');
  return attachment !== undefined && !(replyBody?.textContent ?? '').includes(text);
}
