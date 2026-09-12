import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StrictMode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { TaskStatus } from '../components/tasks/task-status';
import { TaskDetailView, type TaskDetailCommands } from '../components/tasks/task-detail-view';
import { TaskList } from '../components/tasks/task-list';
import { StudioWorkspace } from '../components/studio/studio-workspace';
import StudioPage from '../app/studio/page';
import TaskDetailPage from '../app/tasks/[id]/page';
import { cancelTaskAction, createRetryDraftAction } from '../app/tasks/actions';
import {
  establishAuthenticatedServerSession,
  readAuthenticatedServerSession,
} from '../lib/auth/server-session';
import { openTaskEventStream } from '../lib/task-event-stream';
import { readRetryDraft, saveRetryDraft } from '../lib/studio/retry-drafts';
import { taskGateway } from '../lib/tasks/gateway';
import { isTaskEventCursor } from '../lib/tasks/identifiers';
import {
  formatPoints,
  formatTaskDate,
  parseTaskDetail,
  parseTaskPage,
  parseRetryDraft,
  parseTaskStreamEvent,
  parseTaskStatusSnapshot,
  reduceStatus,
} from '../lib/tasks/runtime';
import type { TaskDetail, TaskStatusSnapshot } from '../lib/tasks/types';

const OWNER_A = '+8613800138000';
const OWNER_B = '+8613900139000';
const SESSION_ID_A = '0198f4d4-21c2-7b7d-8a03-08a0da2a6111';
const SESSION_ID_B = '0198f4d4-21c2-7b7d-8a03-08a0da2a6112';
const TEST_REFRESH_TOKEN = 'R'.repeat(43);
const TASK_CONTEXT_A = { ownerId: OWNER_A } as const;
process.env.USER_WEB_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64url');
const accessToken = (ownerId: string, sessionId: string) => {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'ES256', typ: 'JWT' })}.${encode({
    aud: 'user-web',
    exp: Math.floor(Date.now() / 1_000) + 900,
    iss: 'identity-service',
    sid: sessionId,
    sub: ownerId,
  })}.trusted-gateway-signature`;
};

const clientTaskGateway: TaskDetailCommands = {
  cancelTask: (taskId, options) => taskGateway.cancelTask(taskId, { ...options, ownerId: OWNER_A }),
  createRetryDraft: (taskId) => taskGateway.createRetryDraft(taskId, { ownerId: OWNER_A }),
};

const routerPush = vi.hoisted(() => vi.fn());
const redirectTo = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error('NEXT_REDIRECT');
  }),
);
const fixtureSessionCookies = vi.hoisted(() => new Map<string, string>());
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) => {
        const value = fixtureSessionCookies.get(name);
        return value ? { value } : undefined;
      },
      set: (name: string, value: string) => {
        fixtureSessionCookies.set(name, value);
      },
      delete: (name: string) => fixtureSessionCookies.delete(name),
    }),
}));
vi.mock('next/navigation', () => ({
  redirect: redirectTo,
  useRouter: () => ({ push: routerPush }),
}));

const TRANSITION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';
const TRANSITION_CURSOR = `1:${TRANSITION_ID}`;

const queuedTask: TaskStatusSnapshot = {
  eventId: TRANSITION_CURSOR,
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

beforeEach(async () => {
  redirectTo.mockClear();
  fixtureSessionCookies.clear();
  await establishAuthenticatedServerSession(
    accessToken(OWNER_A, SESSION_ID_A),
    SESSION_ID_A,
    TEST_REFRESH_TOKEN,
    OWNER_A,
  );
});

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
    .mockResolvedValueOnce(Response.json({ statusSnapshot: queuedTask }));
  vi.stubGlobal('fetch', mockFetch);

  render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(mockFetch).toHaveBeenCalledTimes(4);

  const finalInput = mockFetch.mock.calls.at(-1)?.[0];
  const finalUrl =
    typeof finalInput === 'string'
      ? finalInput
      : finalInput instanceof URL
        ? finalInput.toString()
        : finalInput?.url;
  expect(finalUrl).toMatch(/\/api\/tasks\/task-1$/);
  expect(
    mockFetch.mock.calls.every(([, init]) => !new Headers(init?.headers).has('authorization')),
  ).toBe(true);
  expect(
    mockFetch.mock.calls
      .slice(0, 3)
      .every(([, init]) => new Headers(init?.headers).get('Last-Event-ID') === TRANSITION_CURSOR),
  ).toBe(true);
});

it('opens the real task detail page fixture with a WS13-compatible cursor', async () => {
  let request: Request | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('closed', 'AbortError'));
        });
      });
    }),
  );

  const view = render(await TaskDetailPage({ params: Promise.resolve({ id: 'task-1' }) }));
  await waitFor(() => {
    expect(request).toBeDefined();
  });
  expect(request?.headers.get('Last-Event-ID')).toMatch(
    /^(0|[1-9]\d*):[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  view.unmount();
});

it('redirects an expired RSC session to the refresh trampoline without mutating cookies', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 901_000);
  const cookieBefore = new Map(fixtureSessionCookies);

  await expect(TaskDetailPage({ params: Promise.resolve({ id: 'task-1' }) })).rejects.toThrow(
    'NEXT_REDIRECT',
  );

  expect(redirectTo).toHaveBeenCalledWith('/auth/session/refresh?returnTo=%2Ftasks%2Ftask-1');
  expect(fixtureSessionCookies).toEqual(cookieBefore);
});

it('omits Last-Event-ID when an initial snapshot does not contain a WS13 cursor', async () => {
  let request: Request | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      request = new Request(input, init);
      return Promise.resolve(
        new Response('', { headers: { 'content-type': 'text/event-stream' } }),
      );
    }),
  );

  await expect(
    openTaskEventStream('task-1', {
      lastEventId: 'task-1-event-4',
      onEvent: () => undefined,
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('TASK_EVENT_STREAM_CLOSED');
  expect(request?.headers.get('Last-Event-ID')).toBeNull();
});

it.each([`01:${TRANSITION_ID}`, `9007199254740992:${TRANSITION_ID}`, `-1:${TRANSITION_ID}`])(
  'rejects an unsafe WS13 cursor version prefix: %s',
  (cursor) => {
    expect(isTaskEventCursor(cursor)).toBe(false);
  },
);

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

it('parses a valid old WS13 transition so the reducer discards it without reconnecting', () => {
  const transitionId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';
  const oldTransition = parseTaskStreamEvent(
    {
      eventType: 'task-transition',
      eventId: `8:${transitionId}`,
      data: {
        transitionId,
        taskId: 'task-1',
        taskVersion: 8,
        status: 'RUNNING',
        occurredAt: '2026-08-31T08:08:00Z',
      },
    },
    'task-1',
    settledTask,
  );

  expect(reduceStatus(settledTask, oldTransition)).toBe(settledTask);
});

it.each([
  ['unknown status', { ...queuedTask, status: 'UNKNOWN' }],
  ['unsafe revision', { ...queuedTask, revision: Number.MAX_SAFE_INTEGER + 1 }],
  ['invalid public reason', { ...queuedTask, publicReason: { code: 'FAILED', message: '' } }],
  ['invalid calendar date', { ...queuedTask, updatedAt: '2026-02-31T10:00:00.000Z' }],
])('fails closed for %s events', (_label, payload) => {
  expect(() => parseTaskStatusSnapshot(payload)).toThrow();
});

it('falls back after three stream failures then polls the Gateway every five seconds', async () => {
  vi.useFakeTimers();
  const mockFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('stream-1'))
    .mockRejectedValueOnce(new Error('stream-2'))
    .mockRejectedValueOnce(new Error('stream-3'))
    .mockResolvedValue(
      Response.json({
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
  await vi.advanceTimersByTimeAsync(4_999);
  expect(mockFetch).toHaveBeenCalledTimes(3);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(mockFetch).toHaveBeenCalledTimes(4);
  const pollInput = mockFetch.mock.calls[3]?.[0];
  const pollUrl =
    typeof pollInput === 'string'
      ? pollInput
      : pollInput instanceof URL
        ? pollInput.toString()
        : pollInput?.url;
  expect(pollUrl).toMatch(/\/api\/tasks\/task-1$/);
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

it('keeps only one active stream across a StrictMode remount', async () => {
  const signals: AbortSignal[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (init?.signal) signals.push(init.signal);
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('closed', 'AbortError'));
          });
        }),
    ),
  );

  const view = render(
    <StrictMode>
      <TaskStatus taskId="task-1" initial={queuedTask} />
    </StrictMode>,
  );
  await waitFor(() => {
    expect(signals.length).toBeGreaterThanOrEqual(2);
  });
  expect(signals.filter((signal) => !signal.aborted)).toHaveLength(1);
  view.unmount();
  expect(signals.every((signal) => signal.aborted)).toBe(true);
});

it('does not overlap slow polling requests', async () => {
  vi.useFakeTimers();
  let resolvePoll!: (response: Response) => void;
  const mockFetch = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('stream-1'))
    .mockRejectedValueOnce(new Error('stream-2'))
    .mockRejectedValueOnce(new Error('stream-3'))
    .mockImplementationOnce(() => new Promise<Response>((resolve) => (resolvePoll = resolve)));
  vi.stubGlobal('fetch', mockFetch);

  const view = render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(mockFetch).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(mockFetch).toHaveBeenCalledTimes(4);
  resolvePoll(Response.json({ ...detailFixture, statusSnapshot: queuedTask }));
  await vi.advanceTimersByTimeAsync(0);
  view.unmount();
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
      lastEventId: TRANSITION_CURSOR,
      onEvent: (event) => received.push(event),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('TASK_EVENT_STREAM_CLOSED');

  expect(received).toEqual([{ data: runningEvent, eventId: 'event-8', eventType: 'task.status' }]);
  expect(request?.credentials).toBe('include');
  expect(request?.headers.get('accept')).toBe('text/event-stream');
  expect(request?.headers.get('Last-Event-ID')).toBe(TRANSITION_CURSOR);
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

it('accepts the WS13 task-transition SSE protocol forwarded unchanged by WS09', async () => {
  const transitionId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';
  const data = {
    transitionId,
    taskId: 'task-1',
    taskVersion: 3,
    status: 'RUNNING',
    occurredAt: '2026-08-31T08:00:00.123456Z',
  };
  const received: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        new Response(
          `event: task-transition\nid: 3:${transitionId}\ndata: ${JSON.stringify(data)}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      ),
  );

  await expect(
    openTaskEventStream('task-1', {
      onEvent: (event) => received.push(event),
      signal: new AbortController().signal,
    }),
  ).rejects.toThrow('TASK_EVENT_STREAM_CLOSED');
  expect(received).toEqual([{ data, eventId: `3:${transitionId}`, eventType: 'task-transition' }]);
});

it('applies a WS13 transition using the server version and known state contract', async () => {
  const transitionId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';
  const signal = { current: undefined as AbortSignal | undefined };
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      signal.current = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(
          `event: task-transition\nid: 9:${transitionId}\ndata: ${JSON.stringify({
            transitionId,
            taskId: 'task-1',
            taskVersion: 9,
            status: 'SETTLED',
            occurredAt: '2026-08-31T08:09:00.1Z',
          })}\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }),
  );

  render(
    <TaskStatus
      taskId="task-1"
      initial={{
        ...queuedTask,
        eventId: `8:${transitionId}`,
        revision: 8,
        status: 'SUCCEEDED',
        cancelAllowed: false,
      }}
    />,
  );
  expect(await screen.findByText('已结算')).toBeVisible();
  expect(signal.current?.aborted).toBe(true);
});

it('counts malformed payloads as failures and polls after the third failure', async () => {
  vi.useFakeTimers();
  const malformed = () =>
    new Response(
      'event: task.status\nid: bad-event\ndata: {"eventId":"bad-event","status":"UNKNOWN"}\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const mockFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(malformed())
    .mockResolvedValueOnce(malformed())
    .mockResolvedValueOnce(malformed())
    .mockResolvedValueOnce(Response.json({ ...detailFixture, statusSnapshot: queuedTask }));
  vi.stubGlobal('fetch', mockFetch);

  const view = render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(5_000);

  expect(mockFetch).toHaveBeenCalledTimes(4);
  const pollInput = mockFetch.mock.calls[3]?.[0];
  const pollUrl =
    typeof pollInput === 'string'
      ? pollInput
      : pollInput instanceof URL
        ? pollInput.toString()
        : pollInput?.url;
  expect(pollUrl).toMatch(/\/api\/tasks\/task-1$/);
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it('honors the exact WS09 idle reconnect directive without degrading to polling', async () => {
  vi.useFakeTimers();
  const reconnect = () =>
    new Response('retry: 3000\nevent: reconnect\ndata: idle\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  const mockFetch = vi.fn<typeof fetch>().mockImplementation(() => Promise.resolve(reconnect()));
  vi.stubGlobal('fetch', mockFetch);

  const view = render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  await vi.advanceTimersByTimeAsync(2_999);
  expect(mockFetch).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(mockFetch).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(9_000);

  expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(4);
  expect(
    mockFetch.mock.calls.every(([input]) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      return /\/api\/tasks\/task-1\/events$/.test(url);
    }),
  ).toBe(true);
  view.unmount();
});

it('treats a valid old transition as healthy and resets the failure streak', async () => {
  vi.useFakeTimers();
  const malformed = () =>
    new Response('event: task.status\nid: bad\ndata: {}\n\n', {
      headers: { 'content-type': 'text/event-stream' },
    });
  const oldTransition = () =>
    new Response(
      `event: task-transition\nid: 1:${TRANSITION_ID}\ndata: ${JSON.stringify({
        transitionId: TRANSITION_ID,
        taskId: 'task-1',
        taskVersion: 1,
        status: 'QUEUED',
        occurredAt: '2026-08-31T08:00:00Z',
      })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    );
  const mockFetch = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(malformed())
    .mockResolvedValueOnce(malformed())
    .mockResolvedValueOnce(oldTransition())
    .mockImplementation(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('closed', 'AbortError'));
          });
        }),
    );
  vi.stubGlobal('fetch', mockFetch);

  const view = render(<TaskStatus taskId="task-1" initial={queuedTask} />);
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(999);
  expect(mockFetch).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(mockFetch).toHaveBeenCalledTimes(4);
  view.unmount();
});

it('never promotes provider-conditional cancellation from false to true', () => {
  const transitionId = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b2';
  const current: TaskStatusSnapshot = {
    ...queuedTask,
    eventId: `2:${TRANSITION_ID}`,
    revision: 2,
    status: 'SUBMITTING',
    cancelAllowed: false,
  };
  const next = parseTaskStreamEvent(
    {
      eventType: 'task-transition',
      eventId: `3:${transitionId}`,
      data: {
        transitionId,
        taskId: 'task-1',
        taskVersion: 3,
        status: 'RUNNING',
        occurredAt: '2026-08-31T08:03:00Z',
      },
    },
    'task-1',
    current,
  );

  expect(next.cancelAllowed).toBe(false);
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
  expect(received).toEqual([{ data: runningEvent, eventId: 'event-8', eventType: 'task.status' }]);
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
  render(<TaskDetailView detail={detailFixture} gateway={clientTaskGateway} live={false} />);

  expect(screen.getAllByText('9,007,199,254,740,993').length).toBeGreaterThan(0);
  expect(screen.getByText('生成服务暂时繁忙，已为你保留队列位置。')).toBeVisible();
  expect(screen.getByRole('list', { name: '任务时间线' })).toBeVisible();
  expect(screen.getByText('cap-image-v7')).toBeVisible();
  expect(screen.getByText('pricing-2026-08-31')).toBeVisible();
  expect(formatPoints('9007199254740993')).toBe('9,007,199,254,740,993');
  expect(formatTaskDate('2026-08-31T10:00:00.000Z')).toBe('2026-08-31 18:00:00');
});

it('gates cancellation and prevents duplicate clicks while pending or after acceptance', async () => {
  const user = userEvent.setup();
  let resolveCancel!: (value: unknown) => void;
  const cancelTask = vi.fn<TaskDetailCommands['cancelTask']>(
    () => new Promise<unknown>((resolve) => (resolveCancel = resolve)),
  );
  const gateway: TaskDetailCommands = {
    ...clientTaskGateway,
    cancelTask,
  };
  const view = render(<TaskDetailView detail={detailFixture} gateway={gateway} live={false} />);
  const cancel = screen.getByRole('button', { name: '取消任务' });
  await user.dblClick(cancel);
  expect(cancelTask).toHaveBeenCalledTimes(1);
  expect(cancelTask.mock.calls[0]?.[1].idempotencyKey).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  resolveCancel({
    ok: true,
    snapshot: { ...detailFixture.statusSnapshot, cancelAllowed: false, revision: 9 },
  });
  expect(await screen.findByText(/取消请求已接受/)).toBeVisible();
  expect(screen.queryByRole('button', { name: '取消任务' })).not.toBeInTheDocument();
  expect(cancelTask).toHaveBeenCalledTimes(1);
  view.unmount();
  render(
    <TaskDetailView
      detail={{
        ...detailFixture,
        statusSnapshot: { ...detailFixture.statusSnapshot, cancelAllowed: false },
      }}
      gateway={clientTaskGateway}
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
      gateway={{ ...clientTaskGateway, createRetryDraft }}
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
  const gateway: TaskDetailCommands = {
    ...clientTaskGateway,
    cancelTask: vi.fn().mockRejectedValue(new Error('network')),
  };
  render(<TaskDetailView detail={detailFixture} gateway={gateway} live={false} />);

  await user.click(screen.getByRole('button', { name: '取消任务' }));

  expect(await screen.findByText(/任务状态未更改/)).toBeVisible();
  expect(screen.getByText('RUNNING')).toBeVisible();
});

it('reuses one cancellation idempotency key after an ambiguous response failure', async () => {
  const user = userEvent.setup();
  const cancelTask = vi
    .fn<TaskDetailCommands['cancelTask']>()
    .mockResolvedValue({ ok: false, outcome: 'UNCERTAIN' });
  render(
    <TaskDetailView
      detail={detailFixture}
      gateway={{ ...clientTaskGateway, cancelTask }}
      live={false}
    />,
  );

  await user.click(screen.getByRole('button', { name: '取消任务' }));
  await screen.findByText(/任务状态未更改/);
  await user.click(screen.getByRole('button', { name: '取消任务' }));

  expect(cancelTask).toHaveBeenCalledTimes(2);
  expect(cancelTask.mock.calls[1]?.[1].idempotencyKey).toBe(
    cancelTask.mock.calls[0]?.[1].idempotencyKey,
  );
});

it('uses a fresh cancellation idempotency key after a definitive failure', async () => {
  const user = userEvent.setup();
  const cancelTask = vi
    .fn<TaskDetailCommands['cancelTask']>()
    .mockResolvedValue({ ok: false, outcome: 'DEFINITIVE_FAILURE' });
  render(
    <TaskDetailView
      detail={detailFixture}
      gateway={{ ...clientTaskGateway, cancelTask }}
      live={false}
    />,
  );

  await user.click(screen.getByRole('button', { name: '取消任务' }));
  await screen.findByText(/任务状态未更改/);
  await user.click(screen.getByRole('button', { name: '取消任务' }));

  expect(cancelTask).toHaveBeenCalledTimes(2);
  expect(cancelTask.mock.calls[1]?.[1].idempotencyKey).not.toBe(
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
      gateway={{
        ...clientTaskGateway,
        cancelTask: vi.fn().mockResolvedValue({ ok: true, snapshot: terminal }),
      }}
    />,
  );

  await user.click(screen.getByRole('button', { name: '取消任务' }));
  await screen.findByText(/取消请求已接受/);
  expect(document.querySelector('.task-live-status')).toHaveTextContent('已结算');
  expect(streamSignal?.aborted).toBe(true);
});

it('parses typed fixture filters/cursors and rejects unsafe point payloads', async () => {
  const first = parseTaskPage(await taskGateway.listTasks({ status: 'RUNNING' }, TASK_CONTEXT_A));
  expect(first.items.every((task) => task.statusSnapshot.status === 'RUNNING')).toBe(true);
  expect(first.items.some((task) => 'userId' in task)).toBe(false);
  if (first.pageInfo.nextCursor) {
    const next = parseTaskPage(
      await taskGateway.listTasks(
        { status: 'RUNNING', cursor: first.pageInfo.nextCursor },
        TASK_CONTEXT_A,
      ),
    );
    expect(next.pageInfo.previousCursor).toBeTruthy();
  }
  const unfiltered = parseTaskPage(await taskGateway.listTasks({}, TASK_CONTEXT_A));
  const nextCursor = unfiltered.pageInfo.nextCursor;
  expect(nextCursor).toBeTruthy();
  if (!nextCursor) throw new Error('Fixture must expose an opaque next cursor.');
  const next = parseTaskPage(await taskGateway.listTasks({ cursor: nextCursor }, TASK_CONTEXT_A));
  expect(next.pageInfo.previousCursor).toBeTruthy();

  const malformed = { ...detailFixture, quotedPoints: '1.5' };
  expect(() => parseTaskDetail(malformed)).toThrow('INVALID_TASK_POINTS');
  expect(() => parseTaskDetail({ ...detailFixture, quotedPoints: '01' })).toThrow(
    'INVALID_TASK_POINTS',
  );
  expect(parseTaskDetail(await taskGateway.getTask('task-1', TASK_CONTEXT_A)).taskNumber).toBe(
    'T20260831-0001',
  );
});

it('mirrors the frozen UtcDateTime precision and UTC-only semantics', () => {
  expect(
    parseTaskStatusSnapshot({ ...queuedTask, updatedAt: '2026-08-31T10:00:00.1Z' }).updatedAt,
  ).toBe('2026-08-31T10:00:00.1Z');
  expect(
    parseTaskStatusSnapshot({ ...queuedTask, updatedAt: '2026-08-31T10:00:00.123456Z' }).updatedAt,
  ).toBe('2026-08-31T10:00:00.123456Z');
  expect(() =>
    parseTaskStatusSnapshot({ ...queuedTask, updatedAt: '2026-08-31T18:00:00+08:00' }),
  ).toThrow('INVALID_TASK_UPDATED_AT');
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
  const { draftId } = parseRetryDraft(
    await taskGateway.createRetryDraft('task-1', { ownerId: OWNER_A }),
  );
  render(await StudioPage({ searchParams: Promise.resolve({ draft: draftId }) }));

  expect(await screen.findByLabelText('起始图片')).toHaveValue('asset-21');
});

it('binds retry drafts to an owner, expires them and consumes them once', () => {
  const draft = {
    id: 'draft-security-boundary',
    generationMode: 'IMAGE_TO_VIDEO' as const,
    providerId: 'mock-provider-east',
    modelId: 'mock-cinema-v2',
    capabilityVersion: 'cap-image-v7',
    capabilitySchemaVersion: 202012,
    parameters: { image: 'asset-private' },
  };
  saveRetryDraft(draft, { now: 1_000, ownerId: 'session-a', ttlMs: 5_000 });

  expect(readRetryDraft(draft.id, { now: 2_000, ownerId: 'session-b' })).toBeUndefined();
  expect(readRetryDraft(draft.id, { now: 2_000, ownerId: 'session-a' })).toEqual(draft);
  expect(readRetryDraft(draft.id, { now: 2_001, ownerId: 'session-a' })).toBeUndefined();

  saveRetryDraft(
    { ...draft, id: 'draft-expired' },
    { now: 10_000, ownerId: 'session-a', ttlMs: 1 },
  );
  expect(readRetryDraft('draft-expired', { now: 10_002, ownerId: 'session-a' })).toBeUndefined();
});

it('rejects a new retry draft at capacity without evicting an unexpired draft', () => {
  const base = {
    generationMode: 'IMAGE_TO_VIDEO' as const,
    providerId: 'mock-provider-east',
    modelId: 'mock-cinema-v2',
    capabilityVersion: 'cap-image-v7',
    capabilitySchemaVersion: 202012,
    parameters: { image: 'asset-private' },
  };
  for (let index = 0; index < 100; index += 1) {
    saveRetryDraft(
      { ...base, id: `capacity-${String(index).padStart(3, '0')}` },
      { now: 1_000_000_000_000, ownerId: 'session-capacity', ttlMs: 5_000 },
    );
  }
  expect(() => {
    saveRetryDraft(
      { ...base, id: 'capacity-rejected' },
      { now: 1_000_000_000_001, ownerId: 'session-capacity', ttlMs: 5_000 },
    );
  }).toThrow('RETRY_DRAFT_CAPACITY_REACHED');
  expect(
    readRetryDraft('capacity-000', {
      now: 1_000_000_000_001,
      ownerId: 'session-capacity',
    }),
  ).toEqual({ ...base, id: 'capacity-000' });

  saveRetryDraft(
    { ...base, id: 'sweep-trigger' },
    { now: 1_000_000_010_000, ownerId: 'session-capacity', ttlMs: 5_000 },
  );
  expect(
    readRetryDraft('capacity-099', {
      now: 1_000_000_010_000,
      ownerId: 'session-capacity',
    }),
  ).toBeUndefined();
});

it('signs an app session only from the trusted Gateway login result', async () => {
  await expect(readAuthenticatedServerSession()).resolves.toEqual({ ownerId: OWNER_A });
  await establishAuthenticatedServerSession(
    accessToken(OWNER_B, SESSION_ID_B),
    SESSION_ID_B,
    TEST_REFRESH_TOKEN,
    OWNER_B,
  );
  await expect(readAuthenticatedServerSession()).resolves.toEqual({ ownerId: OWNER_B });
  const cookieName = [...fixtureSessionCookies.keys()][0];
  if (!cookieName) throw new Error('MISSING_APP_SESSION_COOKIE');
  const signedCookie = fixtureSessionCookies.get(cookieName);
  if (!signedCookie) throw new Error('MISSING_SIGNED_APP_SESSION');
  fixtureSessionCookies.set(cookieName, `${signedCookie}tampered`);
  await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
  fixtureSessionCookies.clear();
  await expect(readAuthenticatedServerSession()).resolves.toBeUndefined();
});

it('filters list/detail and command fixtures by the authenticated owner', async () => {
  const ownerB = { ownerId: OWNER_B };
  const page = parseTaskPage(await taskGateway.listTasks({}, ownerB));
  expect(page.items).toEqual([]);
  await expect(taskGateway.getTask('task-1', ownerB)).rejects.toThrow('TASK_NOT_FOUND');
  await expect(
    taskGateway.cancelTask('task-1', {
      idempotencyKey: '0198f4d4-21c2-7b7d-8a03-08a0da2a6201',
      ownerId: OWNER_B,
    }),
  ).rejects.toThrow('TASK_NOT_FOUND');
  await expect(taskGateway.createRetryDraft('task-1', ownerB)).rejects.toThrow('TASK_NOT_FOUND');
});

it('fails closed without revealing task existence to unauthenticated or cross-owner actions', async () => {
  fixtureSessionCookies.clear();
  await expect(cancelTaskAction('task-1', '0198f4d4-21c2-7b7d-8a03-08a0da2a6202')).resolves.toEqual(
    { ok: false, outcome: 'DEFINITIVE_FAILURE' },
  );
  await expect(createRetryDraftAction('task-1')).rejects.toThrow('AUTHENTICATION_REQUIRED');

  await establishAuthenticatedServerSession(
    accessToken(OWNER_B, SESSION_ID_B),
    SESSION_ID_B,
    TEST_REFRESH_TOKEN,
    OWNER_B,
  );
  const denied = await cancelTaskAction('task-1', '0198f4d4-21c2-7b7d-8a03-08a0da2a6203');
  const missing = await cancelTaskAction('missing-task', '0198f4d4-21c2-7b7d-8a03-08a0da2a6204');
  expect(denied).toEqual({ ok: false, outcome: 'DEFINITIVE_FAILURE' });
  expect(missing).toEqual(denied);
  await expect(createRetryDraftAction('task-1')).rejects.toThrow('TASK_NOT_FOUND');
});

it('returns an explicit refresh requirement from task actions without performing the mutation', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.now() + 901_000);
  const cancelSpy = vi.spyOn(taskGateway, 'cancelTask');
  const retrySpy = vi.spyOn(taskGateway, 'createRetryDraft');

  await expect(cancelTaskAction('task-1', '0198f4d4-21c2-7b7d-8a03-08a0da2a6205')).resolves.toEqual(
    { ok: false, outcome: 'SESSION_REFRESH_REQUIRED' },
  );
  await expect(createRetryDraftAction('task-1')).resolves.toEqual({
    ok: false,
    outcome: 'SESSION_REFRESH_REQUIRED',
  });
  expect(cancelSpy).not.toHaveBeenCalled();
  expect(retrySpy).not.toHaveBeenCalled();
});

it.each([
  ['provider', { providerId: 'other-provider' }],
  ['model', { modelId: 'missing-model' }],
  ['schema', { capabilitySchemaVersion: 201909 }],
] as const)(
  'fails closed when a retry draft has mismatched %s identity',
  async (_kind, mismatch) => {
    render(
      <StudioWorkspace
        retryDraft={{
          id: 'draft-incompatible',
          generationMode: 'IMAGE_TO_VIDEO',
          providerId: 'mock-provider-east',
          modelId: 'mock-cinema-v2',
          capabilityVersion: 'cap-image-v7',
          capabilitySchemaVersion: 202012,
          parameters: { image: 'asset-private', duration: 5, motion: 'natural' },
          ...mismatch,
        }}
        retryDraftRequested
      />,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('重试草稿');
    expect(screen.queryByDisplayValue('asset-private')).not.toBeInTheDocument();
  },
);

it('binds cancellation idempotency cache entries to the task fingerprint', async () => {
  const key = '0198f4d4-21c2-7b7d-8a03-08a0da2a52b1';
  const first = await taskGateway.cancelTask('task-1', {
    idempotencyKey: key,
    ownerId: OWNER_A,
  });
  await expect(
    taskGateway.cancelTask('task-2', { idempotencyKey: key, ownerId: OWNER_A }),
  ).rejects.toMatchObject({ outcome: 'DEFINITIVE_FAILURE' });
  await expect(
    taskGateway.cancelTask('task-1', { idempotencyKey: key, ownerId: OWNER_A }),
  ).resolves.toEqual(first);
});

it('rejects a UUIDv4 cancellation key at the frozen UUIDv7 boundary', async () => {
  await expect(
    taskGateway.cancelTask('task-1', {
      idempotencyKey: '550e8400-e29b-41d4-a716-446655440000',
      ownerId: OWNER_A,
    }),
  ).rejects.toThrow('INVALID_IDEMPOTENCY_KEY');
});

it('authorizes before cancellation cache lookup and expires stale entries', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-08-31T10:00:00Z'));
  const key = '0198f4d4-21c2-7b7d-8a03-08a0da2a52b2';
  await taskGateway.cancelTask('task-1', { idempotencyKey: key, ownerId: OWNER_A });
  await expect(
    taskGateway.cancelTask('task-1', { idempotencyKey: key, ownerId: OWNER_B }),
  ).rejects.toThrow('TASK_NOT_FOUND');

  vi.setSystemTime(new Date('2026-08-31T10:11:00Z'));
  await expect(
    taskGateway.cancelTask('task-2', { idempotencyKey: key, ownerId: OWNER_A }),
  ).rejects.toThrow('CANCEL_NOT_ALLOWED');
});

it('rejects a new cancellation key at capacity without evicting an accepted key', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2030-08-31T11:00:00Z'));
  const keys = Array.from(
    { length: 101 },
    (_, index) => `0198f4d4-21c2-7b7d-8a03-${index.toString(16).padStart(12, '0')}`,
  );

  const oldestKey = keys[0];
  const rejectedKey = keys[100];
  if (!oldestKey || !rejectedKey) throw new Error('MISSING_CANCEL_CACHE_TEST_KEY');
  const accepted = await taskGateway.cancelTask('task-1', {
    idempotencyKey: oldestKey,
    ownerId: OWNER_A,
  });
  for (const idempotencyKey of keys.slice(1, 100)) {
    await taskGateway.cancelTask('task-1', {
      idempotencyKey,
      ownerId: OWNER_A,
    });
  }

  await expect(
    taskGateway.cancelTask('task-1', {
      idempotencyKey: rejectedKey,
      ownerId: OWNER_A,
    }),
  ).rejects.toThrow('IDEMPOTENCY_CAPACITY_REACHED');
  await expect(
    taskGateway.cancelTask('task-1', { idempotencyKey: oldestKey, ownerId: OWNER_A }),
  ).resolves.toEqual(accepted);
});
