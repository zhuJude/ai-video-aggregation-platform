import '@testing-library/jest-dom/vitest';

import { createHash, randomBytes } from 'node:crypto';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TicketCenter } from '../components/support/ticket-center';
import { commerceGateway } from '../lib/commerce/gateway';
import { ensureMockSeedObjects, transactMockStoreJson } from '../lib/commerce/mock-object-store';
import { supportGateway } from '../lib/support/gateway';
import { runSupportCommand, supportSeed } from '../lib/support/mock-store';
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
      canClose: false,
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
  vi.useRealTimers();
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

  it('reopens only a recently resolved ticket to IN_PROGRESS', async () => {
    const ownerId = createUuidV7();
    const ticketId = await primeTicket(ownerId, 'RESOLVED', new Date().toISOString());

    const reopened = (await supportGateway.changeTicketStatus(ticketId, 'REOPEN', {
      ownerId,
      idempotencyKey: createUuidV7(),
    })) as TicketPage['items'][number];
    expect(reopened.status).toBe('IN_PROGRESS');
    expect(reopened.canReopen).toBe(false);
  });

  it('migrates a legacy resolved support record without weakening the public parser', async () => {
    const ownerId = createUuidV7();
    const updatedAt = '2026-09-10T08:00:00.000Z';
    const seed = supportSeed(ownerId);
    const current = seed.tickets[0];
    if (!current) throw new Error('MISSING_TICKET_FIXTURE');
    const legacyState = {
      ...seed,
      tickets: [
        {
          ...current,
          status: 'RESOLVED' as const,
          updatedAt,
          canClose: true,
          canReopen: true,
          statusHistory: [
            ...current.statusHistory,
            { status: 'RESOLVED' as const, occurredAt: updatedAt, label: '旧版记录已解决' },
          ],
        },
      ],
    };
    const fileName = `.support-${createHash('sha256')
      .update(`support:v2:${ownerId}`)
      .digest('hex')}.json`;
    await transactMockStoreJson(fileName, () => ({ result: undefined, next: legacyState }));

    const listed = (await supportGateway.listTickets({}, { ownerId })) as TicketPage;
    const migrated = listed.items.find(({ id }) => id === current.id);
    if (!migrated) throw new Error('MISSING_MIGRATED_TICKET');
    expect(migrated.reopenUntil).toBe('2026-09-17T08:00:00.000Z');
    const persisted = await transactMockStoreJson<Record<string, unknown> | undefined>(
      fileName,
      (raw) => ({ result: raw as Record<string, unknown> | undefined }),
    );
    expect(
      ((persisted?.tickets as Array<Record<string, unknown>> | undefined)?.[0] ?? {}).reopenUntil,
    ).toBe('2026-09-17T08:00:00.000Z');
    const { reopenUntil: _reopenUntil, ...legacyPublicTicket } = migrated;
    void _reopenUntil;
    expect(() =>
      parseTicketPage({
        items: [legacyPublicTicket],
        pageInfo: {},
      }),
    ).toThrow('INVALID_TICKET');
  });

  it('rejects reopening a resolved ticket after seven days or any closed ticket', async () => {
    const staleOwner = createUuidV7();
    const staleId = await primeTicket(
      staleOwner,
      'RESOLVED',
      new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
    );
    await expect(
      supportGateway.changeTicketStatus(staleId, 'REOPEN', {
        ownerId: staleOwner,
        idempotencyKey: createUuidV7(),
      }),
    ).rejects.toThrow('TICKET_ACTION_NOT_ALLOWED');

    const closedOwner = createUuidV7();
    const closedId = await primeTicket(closedOwner, 'CLOSED', new Date().toISOString());
    await expect(
      supportGateway.changeTicketStatus(closedId, 'REOPEN', {
        ownerId: closedOwner,
        idempotencyKey: createUuidV7(),
      }),
    ).rejects.toThrow('TICKET_ACTION_NOT_ALLOWED');
  });

  it('treats a public reply to a recent resolution as a reopen', async () => {
    const ownerId = createUuidV7();
    const ticketId = await primeTicket(ownerId, 'RESOLVED', new Date().toISOString());
    const replied = (await supportGateway.replyTicket(
      ticketId,
      { body: '问题仍然存在，请继续处理。', attachmentIds: [] },
      { ownerId, idempotencyKey: createUuidV7() },
    )) as TicketPage['items'][number];

    expect(replied.status).toBe('IN_PROGRESS');
    expect(replied.statusHistory.at(-1)?.label).toBe('用户回复并重开工单');
  });

  it('rejects a public reply after the resolved reopen window expires', async () => {
    const ownerId = createUuidV7();
    const ticketId = await primeTicket(
      ownerId,
      'RESOLVED',
      new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
    );

    await expect(
      supportGateway.replyTicket(
        ticketId,
        { body: '超过期限后不应隐式复活工单。', attachmentIds: [] },
        { ownerId, idempotencyKey: createUuidV7() },
      ),
    ).rejects.toThrow('TICKET_NOT_REPLYABLE');
  });

  it('stores an owner-scoped idempotent satisfaction rating for a resolved ticket', async () => {
    const ownerId = createUuidV7();
    const ticketId = await primeTicket(ownerId, 'RESOLVED', new Date().toISOString());
    const gateway = supportGateway as typeof supportGateway & {
      submitTicketSatisfaction(
        ticketId: string,
        input: { rating: number; comment?: string },
        context: { ownerId: string; idempotencyKey: string },
      ): Promise<unknown>;
    };
    const context = { ownerId, idempotencyKey: createUuidV7() };

    const first = await gateway.submitTicketSatisfaction(
      ticketId,
      { rating: 5, comment: '问题已解决。' },
      context,
    );
    await expect(
      gateway.submitTicketSatisfaction(ticketId, { rating: 5, comment: '问题已解决。' }, context),
    ).resolves.toEqual(first);
    await expect(
      gateway.submitTicketSatisfaction(
        ticketId,
        { rating: 5 },
        { ownerId: createUuidV7(), idempotencyKey: createUuidV7() },
      ),
    ).rejects.toThrow('TICKET_NOT_FOUND');
  });

  it('accepts typed model, failed-task and product feedback idempotently', async () => {
    const gateway = supportGateway as typeof supportGateway & {
      submitFeedback(
        input: {
          kind: 'MODEL_RESULT' | 'FAILED_TASK' | 'PRODUCT_SUGGESTION';
          body: string;
          referenceId?: string;
        },
        context: { ownerId: string; idempotencyKey: string },
      ): Promise<unknown>;
    };
    const ownerId = createUuidV7();
    for (const kind of ['MODEL_RESULT', 'FAILED_TASK', 'PRODUCT_SUGGESTION'] as const) {
      const context = { ownerId, idempotencyKey: createUuidV7() };
      const input = {
        kind,
        body: `${kind} 的公开反馈内容。`,
        ...(kind === 'FAILED_TASK' ? { referenceId: 'task-1' } : {}),
      };
      const first = await gateway.submitFeedback(input, context);
      await expect(gateway.submitFeedback(input, context)).resolves.toEqual(first);
    }
  });

  it('recomputes reopen capability and hides reply controls after the seven-day window', async () => {
    const ownerId = createUuidV7();
    await primeTicket(
      ownerId,
      'RESOLVED',
      new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString(),
    );
    const listed = (await supportGateway.listTickets({}, { ownerId })) as TicketPage;
    const stale = listed.items[0];
    expect(stale?.canReopen).toBe(false);

    render(<TicketCenter initial={listed} />);
    expect(screen.queryByRole('button', { name: '重新打开' })).toBeNull();
    expect(screen.queryByRole('button', { name: '发送回复' })).toBeNull();
  });

  it('expires reopen and reply controls while a resolved ticket remains mounted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-13T00:00:00.000Z'));
    const first = page.items[0];
    if (!first) throw new Error('MISSING_TICKET_FIXTURE');
    render(
      <TicketCenter
        initial={{
          items: [
            {
              ...first,
              status: 'RESOLVED',
              canReopen: true,
              reopenUntil: '2026-09-13T00:00:01.000Z',
            },
          ],
          pageInfo: {},
        }}
      />,
    );
    expect(screen.getByRole('button', { name: '重新打开' })).toBeVisible();
    expect(screen.getByRole('button', { name: '发送回复' })).toBeVisible();

    await act(() => {
      vi.advanceTimersByTime(1_001);
      return Promise.resolve();
    });
    expect(screen.queryByRole('button', { name: '重新打开' })).toBeNull();
    expect(screen.queryByRole('button', { name: '发送回复' })).toBeNull();
  });

  it('closes and locks feedback after success while associating field errors explicitly', async () => {
    const user = userEvent.setup();
    const submit = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, outcome: 'DEFINITIVE_FAILURE' })
      .mockResolvedValue({
        ok: true,
        data: {
          id: createUuidV7(),
          kind: 'FAILED_TASK',
          body: '任务结果一直无法正常打开。',
          referenceId: 'task-1',
          createdAt: new Date().toISOString(),
        },
      });
    render(<TicketCenter initial={{ items: [], pageInfo: {} }} onSubmitFeedback={submit} />);
    await user.click(screen.getByRole('button', { name: '提交产品反馈' }));
    await user.selectOptions(screen.getByLabelText('反馈类型'), 'FAILED_TASK');
    await user.type(screen.getByLabelText('关联任务或模型标识（可选）'), 'bad handle!');
    await user.click(screen.getByRole('button', { name: '提交反馈' }));
    expect(screen.getByLabelText('关联任务或模型标识（可选）')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
    expect(screen.getByLabelText('反馈内容')).toHaveAttribute('aria-invalid', 'true');

    await user.clear(screen.getByLabelText('关联任务或模型标识（可选）'));
    await user.type(screen.getByLabelText('关联任务或模型标识（可选）'), 'task-1');
    await user.type(screen.getByLabelText('反馈内容'), '任务结果一直无法正常打开。');
    await user.click(screen.getByRole('button', { name: '提交反馈' }));
    expect(screen.getByText('反馈未提交，请检查内容。')).toHaveAttribute('role', 'alert');
    await user.click(screen.getByRole('button', { name: '提交反馈' }));

    expect(submit).toHaveBeenCalledTimes(2);
    expect(submit.mock.calls[0]?.[1]).toBe(submit.mock.calls[1]?.[1]);
    expect(screen.queryByRole('dialog')).toBeNull();
    const nextFeedback = screen.getByRole('button', { name: '提交产品反馈' });
    expect(nextFeedback).toBeEnabled();
    expect(screen.getByText('反馈已提交，感谢你的建议。')).toHaveAttribute('role', 'status');
    await user.click(nextFeedback);
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(screen.getByLabelText('反馈内容')).toHaveValue('');
  });

  it('renders satisfaction and typed feedback entry points', () => {
    const first = page.items[0];
    if (!first) throw new Error('MISSING_TICKET_FIXTURE');
    const resolved = {
      ...first,
      status: 'RESOLVED' as const,
      canClose: false,
      canReopen: true,
    };
    render(<TicketCenter initial={{ items: [resolved], pageInfo: {} }} />);

    expect(screen.getByRole('button', { name: '评价本次服务' })).toBeVisible();
    expect(screen.getByRole('button', { name: '提交产品反馈' })).toBeVisible();
  });

  it('associates create validation errors with the ticket fields', async () => {
    const user = userEvent.setup();
    render(
      <TicketCenter
        initial={{ items: [], pageInfo: {} }}
        onCreateTicket={vi.fn().mockResolvedValue({ ok: false, outcome: 'DEFINITIVE_FAILURE' })}
      />,
    );
    await user.click(screen.getByRole('button', { name: '创建新工单' }));
    await user.type(screen.getByLabelText('工单标题'), '任务结果异常');
    await user.type(screen.getByLabelText('问题描述'), '任务结果与预期不符，请协助核查。');
    await user.click(screen.getByRole('button', { name: '提交工单' }));

    expect(screen.getByLabelText('工单标题')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('问题描述')).toHaveAccessibleDescription(
      '工单未提交，请检查内容和附件。',
    );
  });
});

async function primeTicket(
  ownerId: string,
  status: 'RESOLVED' | 'CLOSED',
  updatedAt: string,
): Promise<string> {
  return runSupportCommand(
    ownerId,
    {
      key: createUuidV7(),
      kind: 'TICKET_STATUS',
      fingerprint: `test-prime:${status}:${updatedAt}`,
    },
    (state) => {
      const current = state.tickets[0];
      if (!current) throw new Error('MISSING_TICKET_FIXTURE');
      state.tickets[0] = {
        ...current,
        status,
        updatedAt,
        canClose: false,
        canReopen: status === 'RESOLVED',
        ...(status === 'RESOLVED'
          ? { reopenUntil: new Date(Date.parse(updatedAt) + 7 * 24 * 60 * 60_000).toISOString() }
          : {}),
      };
      return current.id;
    },
  );
}

function withinReply(reply: HTMLElement, text: string): boolean {
  const attachment = Array.from(reply.querySelectorAll('[data-ticket-attachment]')).find((node) =>
    node.textContent.includes(text),
  );
  const replyBody = reply.querySelector('[data-ticket-body]');
  return attachment !== undefined && !(replyBody?.textContent ?? '').includes(text);
}
