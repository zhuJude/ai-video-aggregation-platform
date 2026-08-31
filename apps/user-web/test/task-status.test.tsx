import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

import { TaskStatus } from '../components/tasks/task-status';
import { TaskDetailView } from '../components/tasks/task-detail-view';
import { TaskList } from '../components/tasks/task-list';
import StudioPage from '../app/studio/page';
import { openTaskEventStream } from '../lib/task-event-stream';
import { taskGateway } from '../lib/tasks/gateway';
import {
  formatPoints,
  formatTaskDate,
  parseTaskDetail,
  parseTaskPage,
  parseRetryDraft,
  parseTaskStatusSnapshot,
  reduceStatus,
} from '../lib/tasks/runtime';
import type { TaskDetail, TaskGateway, TaskStatusSnapshot } from '../lib/tasks/types';

const routerPush = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: routerPush }),
}));

const queuedTask: TaskStatusSnapshot = {
  eventId: 'event-1',
  revision: 1,
  status: 'QUEUED',
  terminal: false,
  cancelAllowed: true,
  updatedAt: '2026-08-31T10:00:00.000Z',
};

const settledTask: TaskStatusSnapshot = {
  eventId: 'event-9',
  revision: 9,
  status: 'SETTLED',
  terminal: true,
  cancelAllowed: false,
  updatedAt: '2026-08-31T10:09:00.000Z',
};

const runningEvent: TaskStatusSnapshot = {
  eventId: 'event-8',
  revision: 8,
  status: 'RUNNING',
  terminal: false,
  cancelAllowed: true,
  updatedAt: '2026-08-31T10:08:00.000Z',
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  routerPush.mockReset();
});

it('reconnects with Last-Event-ID and falls back to polling', async () => {
  vi.useFakeTimers();
  const mockFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('stream-1'))
    .mockRejectedValueOnce(new Error('stream-2'))
    .mockRejectedValueOnce(new Error('stream-3'))
    .mockRejectedValueOnce(new Error('stream-4'))
    .mockResolvedValueOnce(
      Response.json({
        ...detailFixture,
        statusSnapshot: queuedTask,
      }),
    );
  vi.stubGlobal('fetch', mockFetch);

  render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(4_000);
  await vi.advanceTimersByTimeAsync(5_000);

  const finalInput = mockFetch.mock.calls.at(-1)?.[0];
  const finalUrl =
    typeof finalInput === 'string'
      ? finalInput
      : finalInput instanceof URL
        ? finalInput.toString()
        : finalInput?.url;
  expect(finalUrl).toMatch(/\/v1\/tasks\/task-1$/);
  expect(
    mockFetch.mock.calls.some(
      ([, init]) => new Headers(init?.headers).get('Last-Event-ID') === 'event-1',
    ),
  ).toBe(true);
});

it('does not regress a terminal status on an old event', () => {
  expect(reduceStatus(settledTask, runningEvent)).toEqual(settledTask);
});

it('discards old and duplicate revisions without guessing from timestamps', () => {
  const misleadingOldEvent = {
    ...runningEvent,
    eventId: 'event-new-date',
    revision: settledTask.revision,
    updatedAt: '2099-08-31T10:08:00.000Z',
  };
  const current = { ...runningEvent, eventId: 'event-current', revision: 7 };

  expect(reduceStatus(current, { ...runningEvent, revision: 6 })).toBe(current);
  expect(reduceStatus(settledTask, misleadingOldEvent)).toBe(settledTask);
});

it.each([
  ['unknown status', { ...queuedTask, status: 'UNKNOWN' }],
  ['unsafe revision', { ...queuedTask, revision: Number.MAX_SAFE_INTEGER + 1 }],
  ['invalid public reason', { ...queuedTask, publicReason: { code: 'FAILED', message: '' } }],
  ['invalid calendar date', { ...queuedTask, updatedAt: '2026-02-31T10:00:00.000Z' }],
])('fails closed for %s events', (_label, payload) => {
  expect(() => parseTaskStatusSnapshot(payload)).toThrow();
});

it('uses 1s/2s/4s reconnects then polls the Gateway every five seconds', async () => {
  vi.useFakeTimers();
  const mockFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('stream-1'))
    .mockRejectedValueOnce(new Error('stream-2'))
    .mockRejectedValueOnce(new Error('stream-3'))
    .mockRejectedValueOnce(new Error('stream-4'))
    .mockResolvedValue(
      Response.json({
        ...detailFixture,
        statusSnapshot: {
          ...queuedTask,
          eventId: 'event-2',
          revision: 2,
          status: 'RUNNING',
        },
      }),
    );
  vi.stubGlobal('fetch', mockFetch);

  const view = render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(mockFetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(mockFetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(3_999);
  expect(mockFetch).toHaveBeenCalledTimes(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(mockFetch).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(4_999);
  expect(mockFetch).toHaveBeenCalledTimes(4);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(mockFetch).toHaveBeenCalledTimes(5);
  const pollInput = mockFetch.mock.calls[4]?.[0];
  const pollUrl =
    typeof pollInput === 'string'
      ? pollInput
      : pollInput instanceof URL
        ? pollInput.toString()
        : pollInput?.url;
  expect(pollUrl).toMatch(/\/v1\/tasks\/task-1$/);
  expect(screen.getByText('生成中')).toBeVisible();

  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not open a duplicate stream when only the parent callback identity changes', () => {
  const fetchMock = vi.fn<typeof fetch>(
    (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('closed', 'AbortError'));
        });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const view = render(
    <TaskStatus taskId="task-1" initial={queuedTask} onChange={() => undefined} />,
  );

  view.rerender(<TaskStatus taskId="task-1" initial={queuedTask} onChange={() => undefined} />);

  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it('aborts the stream and clears all timers as soon as the API declares terminal', async () => {
  vi.useFakeTimers();
  let streamSignal: AbortSignal | undefined;
  const terminalEvent = { ...settledTask, eventId: 'event-10', revision: 10 };
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      streamSignal = init?.signal ?? undefined;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `event: task.status\nid: ${terminalEvent.eventId}\ndata: ${JSON.stringify(terminalEvent)}\n\n`,
            ),
          );
          init?.signal?.addEventListener(
            'abort',
            () => {
              controller.close();
            },
            { once: true },
          );
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { 'content-type': 'text/event-stream' } }),
      );
    }),
  );

  render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

  expect(screen.getByText('已结算')).toBeVisible();
  expect(streamSignal?.aborted).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('parses CRLF, comments and multi-line SSE data while sending credentials and metadata', async () => {
  let request: Request | undefined;
  const received: unknown[] = [];
  const splitPayload = JSON.stringify({ ...runningEvent, eventId: 'event-8' }).replace(
    '"status"',
    '\n"status"',
  );
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Promise.resolve(
        new Response(
          `: heartbeat\r\n\r\nevent: task.status\r\nid: event-8\r\ndata: ${splitPayload.replace('\n', '\r\ndata: ')}\r\n\r\n`,
          { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
        ),
      );
    }),
  );

  await expect(
    openTaskEventStream('task-1', {
      lastEventId: 'event-7',
      onEvent: (event) => received.push(event),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('TASK_EVENT_STREAM_CLOSED');

  expect(received).toEqual([{ data: runningEvent, eventId: 'event-8' }]);
  expect(request?.credentials).toBe('include');
  expect(request?.headers.get('accept')).toBe('text/event-stream');
  expect(request?.headers.get('Last-Event-ID')).toBe('event-7');
  expect(request?.headers.get('x-trace-id')).toMatch(/^[a-f0-9]{32}$/);
  expect(request?.headers.get('x-correlation-id')).toBeTruthy();
});

it('fails closed on malformed SSE JSON without applying an event', async () => {
  const onEvent = vi.fn();
  const cancel = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode('event: task.status\nid: event-bad\ndata: {bad}\n\n'),
              );
            },
            cancel,
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    ),
  );

  await expect(
    openTaskEventStream('task-1', {
      onEvent,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('INVALID_TASK_EVENT_JSON');
  expect(onEvent).not.toHaveBeenCalled();
  expect(cancel).toHaveBeenCalledTimes(1);
});

it('preserves an SSE frame when CRLF is split across network chunks', async () => {
  const received: unknown[] = [];
  const payload = JSON.stringify(runningEvent);
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: task.status\r\nid: event-8\r'));
              controller.enqueue(new TextEncoder().encode(`\ndata: ${payload}\r\n\r\n`));
              controller.close();
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
    ),
  );

  await expect(
    openTaskEventStream('task-1', {
      onEvent: (event) => received.push(event),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('TASK_EVENT_STREAM_CLOSED');
  expect(received).toEqual([{ data: runningEvent, eventId: 'event-8' }]);
});

const detailFixture: TaskDetail = {
  id: 'task-1',
  taskNumber: 'T20260831-0001',
  generationMode: 'IMAGE_TO_VIDEO',
  modelName: 'Cinema V2',
  providerName: '演示平台 East',
  createdAt: '2026-08-31T10:00:00.000Z',
  quotedPoints: '9007199254740993',
  statusSnapshot: {
    ...runningEvent,
    publicReason: { code: 'PROVIDER_BUSY', message: '生成服务暂时繁忙，已为你保留队列位置。' },
  },
  modelSnapshot: {
    modelId: 'mock-cinema-v2',
    modelName: 'Cinema V2',
    providerId: 'mock-provider-east',
    providerName: '演示平台 East',
    capabilityVersion: 'cap-image-v7',
    pricingVersion: 'pricing-2026-08-31',
  },
  parametersSnapshot: { prompt: '私密的画面描述', image: 'asset-private' },
  parameterSummary: [
    { key: 'prompt', label: '画面描述', value: '私密的画面描述' },
    { key: 'image', label: '起始图片', value: '素材 #A-21' },
  ],
  financial: {
    availablePoints: '9007199254740993',
    frozenPoints: '240',
    settledPoints: '0',
    refundedPoints: '0',
  },
  timeline: [
    { ...queuedTask, label: '任务已进入队列' },
    { ...runningEvent, label: '生成服务正在处理' },
  ],
};

it('renders all filters and preserves opaque cursor navigation without exposing a user id', () => {
  render(
    <TaskList
      filters={{ status: 'RUNNING', generationMode: 'IMAGE_TO_VIDEO', taskNumber: 'T2026' }}
      page={{
        items: [detailFixture],
        pageInfo: { previousCursor: 'opaque-prev', nextCursor: 'opaque-next' },
      }}
    />,
  );

  for (const label of ['状态', '时间', '模型', '生成方式', '任务编号']) {
    expect(screen.getByLabelText(label)).toBeVisible();
  }
  expect(screen.getByRole('link', { name: '上一页' })).toHaveAttribute(
    'href',
    expect.stringContaining('cursor=opaque-prev'),
  );
  expect(screen.getByRole('link', { name: '下一页' })).toHaveAttribute(
    'href',
    expect.stringContaining('cursor=opaque-next'),
  );
  expect(document.body.textContent).not.toContain('userId');
});

it('renders a useful empty state for filters with no matches', () => {
  render(<TaskList filters={{ taskNumber: 'missing' }} page={{ items: [], pageInfo: {} }} />);
  expect(screen.getByRole('heading', { name: '没有匹配的任务' })).toBeVisible();
  expect(screen.getByRole('link', { name: '开始生成' })).toHaveAttribute('href', '/studio');
});

it('shows exact BigInt financial state, normalized reasons and an accessible timeline', () => {
  render(<TaskDetailView detail={detailFixture} gateway={taskGateway} live={false} />);

  expect(screen.getAllByText('9,007,199,254,740,993').length).toBeGreaterThan(0);
  expect(screen.getByText('生成服务暂时繁忙，已为你保留队列位置。')).toBeVisible();
  expect(screen.getByRole('list', { name: '任务时间线' })).toBeVisible();
  expect(screen.getByText('cap-image-v7')).toBeVisible();
  expect(screen.getByText('pricing-2026-08-31')).toBeVisible();
  expect(formatPoints('9007199254740993')).toBe('9,007,199,254,740,993');
  expect(formatTaskDate('2026-08-31T10:00:00.000Z')).toBe('2026-08-31 18:00:00');
});

it('gates cancellation and prevents duplicate clicks while the command is pending', async () => {
  const user = userEvent.setup();
  let resolveCancel!: (value: unknown) => void;
  const cancelTask = vi.fn<TaskGateway['cancelTask']>(
    () => new Promise<unknown>((resolve) => (resolveCancel = resolve)),
  );
  const gateway: TaskGateway = {
    ...taskGateway,
    cancelTask,
  };
  const view = render(<TaskDetailView detail={detailFixture} gateway={gateway} live={false} />);
  const cancel = screen.getByRole('button', { name: '取消任务' });
  await user.dblClick(cancel);
  expect(cancelTask).toHaveBeenCalledTimes(1);
  expect(cancelTask.mock.calls[0]?.[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/i);

  resolveCancel({ ...detailFixture.statusSnapshot, cancelAllowed: false, revision: 9 });
  view.unmount();
  render(
    <TaskDetailView
      detail={{
        ...detailFixture,
        statusSnapshot: { ...detailFixture.statusSnapshot, cancelAllowed: false },
      }}
      gateway={taskGateway}
      live={false}
    />,
  );
  expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeInTheDocument();
});

it('creates an opaque retry draft and never puts parameters in the URL', async () => {
  const user = userEvent.setup();
  const createRetryDraft = vi.fn().mockResolvedValue({ draftId: 'draft-opaque-1' });
  render(
    <TaskDetailView
      detail={detailFixture}
      gateway={{ ...taskGateway, createRetryDraft }}
      live={false}
    />,
  );

  await user.click(screen.getByRole('button', { name: '复制参数并重新报价' }));
  expect(createRetryDraft).toHaveBeenCalledWith('task-1');
  expect(routerPush).toHaveBeenCalledWith('/studio?draft=draft-opaque-1');
  expect(routerPush.mock.calls[0]?.[0]).not.toContain('私密的画面描述');
  expect(routerPush.mock.calls[0]?.[0]).not.toContain('asset-private');
});

it('does not invent a terminal state when cancellation fails', async () => {
  const user = userEvent.setup();
  const gateway: TaskGateway = {
    ...taskGateway,
    cancelTask: vi.fn().mockRejectedValue(new Error('network')),
  };
  render(<TaskDetailView detail={detailFixture} gateway={gateway} live={false} />);

  await user.click(screen.getByRole('button', { name: '取消任务' }));

  expect(await screen.findByText(/任务状态未更改/)).toBeVisible();
  expect(screen.getByText('RUNNING')).toBeVisible();
});

it('reuses one cancellation idempotency key after an ambiguous response failure', async () => {
  const user = userEvent.setup();
  const cancelTask = vi.fn<TaskGateway['cancelTask']>().mockRejectedValue(new Error('network'));
  render(
    <TaskDetailView detail={detailFixture} gateway={{ ...taskGateway, cancelTask }} live={false} />,
  );

  await user.click(screen.getByRole('button', { name: '取消任务' }));
  await screen.findByText(/任务状态未更改/);
  await user.click(screen.getByRole('button', { name: '取消任务' }));

  expect(cancelTask).toHaveBeenCalledTimes(2);
  expect(cancelTask.mock.calls[1]?.[1].idempotencyKey).toBe(
    cancelTask.mock.calls[0]?.[1].idempotencyKey,
  );
});

it('stops a live stream when cancellation supplies a newer API-declared terminal state', async () => {
  const user = userEvent.setup();
  let streamSignal: AbortSignal | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          streamSignal = init?.signal ?? undefined;
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('closed', 'AbortError'));
          });
        }),
    ),
  );
  const terminal = { ...settledTask, eventId: 'cancel-terminal', revision: 12 };
  render(
    <TaskDetailView
      detail={detailFixture}
      gateway={{ ...taskGateway, cancelTask: vi.fn().mockResolvedValue(terminal) }}
    />,
  );

  await user.click(screen.getByRole('button', { name: '取消任务' }));
  await screen.findByText(/取消请求已接受/);
  expect(document.querySelector('.task-live-status')).toHaveTextContent('已结算');
  expect(streamSignal?.aborted).toBe(true);
});

it('parses typed fixture filters/cursors and rejects unsafe point payloads', async () => {
  const first = parseTaskPage(await taskGateway.listTasks({ status: 'RUNNING' }));
  expect(first.items.every((task) => task.statusSnapshot.status === 'RUNNING')).toBe(true);
  expect(first.items.some((task) => 'userId' in task)).toBe(false);
  if (first.pageInfo.nextCursor) {
    const next = parseTaskPage(
      await taskGateway.listTasks({ status: 'RUNNING', cursor: first.pageInfo.nextCursor }),
    );
    expect(next.pageInfo.previousCursor).toBeTruthy();
  }
  const unfiltered = parseTaskPage(await taskGateway.listTasks({}));
  const nextCursor = unfiltered.pageInfo.nextCursor;
  expect(nextCursor).toBeTruthy();
  if (!nextCursor) throw new Error('Fixture must expose an opaque next cursor.');
  const next = parseTaskPage(await taskGateway.listTasks({ cursor: nextCursor }));
  expect(next.pageInfo.previousCursor).toBeTruthy();

  const malformed = { ...detailFixture, quotedPoints: '1.5' };
  expect(() => parseTaskDetail(malformed)).toThrow('INVALID_TASK_POINTS');
  expect(parseTaskDetail(await taskGateway.getTask('task-1')).taskNumber).toBe('T20260831-0001');
});

it('rejects internal/provider error fields instead of exposing them as public reasons', () => {
  expect(() =>
    parseTaskDetail({
      ...detailFixture,
      rawProviderError: 'secret-upstream-stack',
    }),
  ).toThrow('UNKNOWN_TASK_DETAIL_FIELD');
});

it('resolves an opaque server-side retry draft in Studio without URL parameters', async () => {
  const { draftId } = parseRetryDraft(await taskGateway.createRetryDraft('task-1'));
  render(await StudioPage({ searchParams: Promise.resolve({ draft: draftId }) }));

  expect(await screen.findByLabelText('起始图片')).toHaveValue('asset-21');
});
