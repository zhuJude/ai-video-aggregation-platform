import { PassThrough, type Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  TaskEventsRoute,
  type TaskOwnershipVerifier,
  type TaskStreamSource,
} from '../src/routes/task-events.route.js';
import type { ServiceRequestContext } from '../src/clients/service-client.js';

class FakeStreamSource implements TaskStreamSource {
  readonly streams: PassThrough[] = [];
  context: ServiceRequestContext | undefined;
  lastEventId: string | undefined;

  open(input: {
    lastEventId: string | undefined;
    context: ServiceRequestContext | undefined;
    signal: AbortSignal;
    taskId: string;
  }): Promise<Readable> {
    this.context = input.context;
    this.lastEventId = input.lastEventId;
    const stream = new PassThrough();
    input.signal.addEventListener('abort', () => stream.destroy(), { once: true });
    this.streams.push(stream);
    return Promise.resolve(stream);
  }
}

describe('task event streams', () => {
  it('rejects a task event stream owned by another user', async () => {
    const ownership: TaskOwnershipVerifier = { isOwned: vi.fn().mockResolvedValue(false) };
    const route = new TaskEventsRoute(ownership, new FakeStreamSource());

    await expect(route.open({ taskId: 'other-task', userId: 'user-1' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });

  it('forwards Last-Event-ID on reconnect and disables buffering and caching', async () => {
    const isOwned = vi.fn().mockResolvedValue(true);
    const ownership: TaskOwnershipVerifier = { isOwned };
    const source = new FakeStreamSource();
    const route = new TaskEventsRoute(ownership, source);
    const context = {
      correlationId: 'b'.repeat(32),
      subjectAssertion: 'internal-assertion',
      traceId: 'a'.repeat(32),
    };
    const session = await route.open({
      context,
      lastEventId: '42',
      taskId: 'own-task',
      userId: 'user-1',
    });

    expect(source.lastEventId).toBe('42');
    expect(source.context).toEqual(context);
    expect(isOwned).toHaveBeenCalledWith('own-task', 'user-1', context);
    expect(session.headers).toMatchObject({
      'cache-control': 'no-cache, no-store, must-revalidate',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    session.close();
  });

  it('caps each user at five active streams', async () => {
    const ownership: TaskOwnershipVerifier = { isOwned: vi.fn().mockResolvedValue(true) };
    const route = new TaskEventsRoute(ownership, new FakeStreamSource());
    const sessions = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        route.open({ taskId: `task-${String(index)}`, userId: 'user-1' }),
      ),
    );

    await expect(route.open({ taskId: 'task-6', userId: 'user-1' })).rejects.toMatchObject({
      code: 'SSE_CONNECTION_LIMIT',
    });
    sessions.forEach((session) => {
      session.close();
    });
  });

  it('aborts the upstream and releases the connection slot when the client disconnects', async () => {
    const ownership: TaskOwnershipVerifier = { isOwned: vi.fn().mockResolvedValue(true) };
    const source = new FakeStreamSource();
    const route = new TaskEventsRoute(ownership, source);
    const client = new AbortController();
    const session = await route.open({
      clientSignal: client.signal,
      taskId: 'task-1',
      userId: 'user-1',
    });

    expect(route.activeConnections('user-1')).toBe(1);
    client.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(source.streams[0]?.destroyed).toBe(true);
    expect(session.stream.destroyed).toBe(true);
    expect(route.activeConnections('user-1')).toBe(0);
  });

  it('does not open an upstream stream after the client has already disconnected', async () => {
    const ownership: TaskOwnershipVerifier = { isOwned: vi.fn().mockResolvedValue(true) };
    const source = new FakeStreamSource();
    const route = new TaskEventsRoute(ownership, source);
    const client = new AbortController();
    client.abort();

    await expect(
      route.open({
        clientSignal: client.signal,
        taskId: 'task-1',
        userId: 'user-1',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(source.streams).toHaveLength(0);
    expect(route.activeConnections('user-1')).toBe(0);
  });
});
