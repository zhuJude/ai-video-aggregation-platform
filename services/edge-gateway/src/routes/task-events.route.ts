import { PassThrough, type Readable } from 'node:stream';
import { PublicApiError } from '@repo/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { UserSubject } from '../auth/subject.js';

export interface TaskOwnershipVerifier {
  isOwned(taskId: string, userId: string): Promise<boolean>;
}

export interface TaskStreamSource {
  open(input: {
    lastEventId: string | undefined;
    signal: AbortSignal;
    taskId: string;
  }): Promise<Readable>;
}

export interface TaskEventSession {
  readonly headers: Readonly<Record<string, string>>;
  readonly stream: Readable;
  close(): void;
}

export interface OpenTaskEventStream {
  readonly clientSignal?: AbortSignal;
  readonly lastEventId?: string;
  readonly taskId: string;
  readonly userId: string;
}

export interface TaskEventsRouteOptions {
  readonly heartbeatMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxConnectionsPerUser?: number;
}

const SSE_HEADERS = {
  'cache-control': 'no-cache, no-store, must-revalidate',
  connection: 'keep-alive',
  'content-type': 'text/event-stream; charset=utf-8',
  'x-accel-buffering': 'no',
} as const;

export class TaskEventsRoute {
  private readonly connections = new Map<string, number>();
  private readonly heartbeatMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxConnectionsPerUser: number;

  constructor(
    private readonly ownership: TaskOwnershipVerifier,
    private readonly source: TaskStreamSource,
    options: TaskEventsRouteOptions = {},
  ) {
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 120_000;
    this.maxConnectionsPerUser = options.maxConnectionsPerUser ?? 5;
  }

  activeConnections(userId: string): number {
    return this.connections.get(userId) ?? 0;
  }

  async open(input: OpenTaskEventStream): Promise<TaskEventSession> {
    if (!(await this.ownership.isOwned(input.taskId, input.userId))) {
      throw new PublicApiError('NOT_FOUND', '任务不存在', false);
    }
    if (input.lastEventId !== undefined && !/^[\x20-\x7e]{1,256}$/.test(input.lastEventId)) {
      throw new PublicApiError('BAD_REQUEST', 'Last-Event-ID 格式无效', false);
    }
    const active = this.activeConnections(input.userId);
    if (active >= this.maxConnectionsPerUser) {
      throw new PublicApiError('SSE_CONNECTION_LIMIT', '任务事件连接数过多', true);
    }
    this.connections.set(input.userId, active + 1);

    const upstreamAbort = new AbortController();
    let upstream: Readable;
    try {
      upstream = await this.source.open({
        lastEventId: input.lastEventId,
        signal: upstreamAbort.signal,
        taskId: input.taskId,
      });
    } catch (error) {
      this.release(input.userId);
      throw error;
    }

    const output = new PassThrough();
    let closed = false;
    let idleTimer: NodeJS.Timeout;
    const heartbeat = setInterval(() => {
      if (!closed) output.write(': heartbeat\n\n');
    }, this.heartbeatMs);
    heartbeat.unref();

    const clientDisconnected = (): void => {
      close(true);
    };
    const resetIdle = (): void => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (!closed) {
          output.write('retry: 3000\nevent: reconnect\ndata: idle\n\n');
          output.end();
          close(false);
        }
      }, this.idleTimeoutMs);
      idleTimer.unref();
    };
    const close = (destroyOutput: boolean): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(idleTimer);
      input.clientSignal?.removeEventListener('abort', clientDisconnected);
      upstreamAbort.abort();
      upstream.unpipe(output);
      upstream.destroy();
      if (destroyOutput) output.destroy();
      this.release(input.userId);
    };

    resetIdle();
    input.clientSignal?.addEventListener('abort', clientDisconnected, { once: true });
    upstream.on('data', resetIdle);
    upstream.once('end', () => {
      output.end();
      close(false);
    });
    upstream.once('error', (error) => {
      output.destroy(error);
      close(true);
    });
    output.once('close', () => {
      close(true);
    });
    upstream.pipe(output, { end: false });

    return {
      close: () => {
        close(true);
      },
      headers: SSE_HEADERS,
      stream: output,
    };
  }

  private release(userId: string): void {
    const remaining = this.activeConnections(userId) - 1;
    if (remaining <= 0) this.connections.delete(userId);
    else this.connections.set(userId, remaining);
  }
}

export function registerTaskEventsRoute(
  app: FastifyInstance,
  taskEvents: TaskEventsRoute,
  authenticate: (request: FastifyRequest) => Promise<UserSubject>,
): void {
  app.get<{ Params: { taskId: string } }>('/v1/tasks/:taskId/events', async (request, reply) => {
    const subject = await authenticate(request);
    const client = new AbortController();
    request.raw.once('close', () => {
      client.abort();
    });
    const incomingLastEventId = request.headers['last-event-id'];
    const session = await taskEvents.open({
      clientSignal: client.signal,
      ...(typeof incomingLastEventId === 'string' ? { lastEventId: incomingLastEventId } : {}),
      taskId: request.params.taskId,
      userId: subject.subjectId,
    });
    reply.hijack();
    reply.raw.writeHead(200, session.headers);
    session.stream.pipe(reply.raw);
    return reply;
  });
}
