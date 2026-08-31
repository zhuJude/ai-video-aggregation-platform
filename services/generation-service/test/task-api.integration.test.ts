/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { createHash } from 'node:crypto';
import { firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { TasksController, type AuthenticatedRequest } from '../src/http/tasks.controller.js';
import {
  GenerationExceptionFilter,
  generationErrorStatus,
} from '../src/http/generation-exception.filter.js';
import { GenerationApplicationError } from '../src/application/errors.js';
import { AuthenticatedPrincipalGuard } from '../src/http/authenticated-principal.guard.js';
import { GenerationApiModule } from '../src/http/generation-api.module.js';
import {
  TaskEventsService,
  type TaskEventStreamPort,
} from '../src/application/task-events.service.js';
import { canonicalJson } from '../src/domain/canonical-json.js';

const USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2';
const SPOOFED_USER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a9';
const TASK_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b0';
const TRANSITION_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51b1';

const request: AuthenticatedRequest = { principal: { userId: USER_ID } };

describe('task HTTP application boundary', () => {
  it('rejects requests unless an upstream authenticator supplied a UUIDv7 principal', () => {
    const guard = new AuthenticatedPrincipalGuard();
    const context = (principal: unknown) =>
      ({
        switchToHttp: () => ({ getRequest: () => ({ principal }) }),
      }) as never;

    expect(guard.canActivate(context({ userId: USER_ID }))).toBe(true);
    expect(() => guard.canActivate(context(undefined))).toThrow(
      expect.objectContaining({ status: 401 }),
    );
    expect(() => guard.canActivate(context({ userId: 'not-a-user' }))).toThrow(
      expect.objectContaining({ status: 401 }),
    );
  });

  it('provides deployable Nest wiring for the controller dependencies', () => {
    const create = { execute: vi.fn() };
    const tasks = {} as never;
    const events = {} as never;
    const module = GenerationApiModule.register({ createTasks: create, tasks, events });

    expect(module.controllers).toContain(TasksController);
    expect(module.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ useValue: create }),
        expect.objectContaining({ useValue: tasks }),
        expect.objectContaining({ useValue: events }),
      ]),
    );
  });

  it('maps stable application errors without exposing implementation failures', () => {
    expect(generationErrorStatus(new GenerationApplicationError('TASK_NOT_FOUND'))).toBe(404);
    expect(generationErrorStatus(new GenerationApplicationError('IDEMPOTENCY_CONFLICT'))).toBe(409);
    expect(
      generationErrorStatus(new GenerationApplicationError('TASK_CREATION_FAILED', true)),
    ).toBe(503);
  });

  it('maps a raw repository failure crossing the controller to a generic traced 500 envelope', async () => {
    const send = vi.fn();
    const status = vi.fn(() => ({ send }));
    const logger = { error: vi.fn() };
    const filter = new GenerationExceptionFilter(logger);
    const tasks = {
      get: vi.fn(async () => {
        throw new Error('postgres password leaked');
      }),
    };
    const controller = new TasksController({ execute: vi.fn() }, tasks as never, {} as never);
    const host = {
      switchToHttp: () => ({
        getResponse: () => ({ status }),
        getRequest: () => ({ headers: { 'x-trace-id': 'd'.repeat(32) } }),
      }),
    };
    let failure: unknown;
    try {
      await controller.get(request, TASK_ID);
    } catch (error) {
      failure = error;
    }

    filter.catch(failure, host as never);

    expect(tasks.get).toHaveBeenCalledWith(USER_ID, TASK_ID);
    expect(status).toHaveBeenCalledWith(500);
    expect(send).toHaveBeenCalledWith({
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      retryable: false,
      traceId: 'd'.repeat(32),
    });
    expect(JSON.stringify(send.mock.calls)).not.toContain('postgres password leaked');
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`traceId=${'d'.repeat(32)}`),
      expect.stringContaining('postgres password leaked'),
    );
  });

  it('derives task ownership from the authenticated principal on create', async () => {
    const create = {
      execute: vi.fn(async () => ({
        taskId: TASK_ID,
        status: 'QUEUED' as const,
        version: 2 as const,
      })),
    };
    const controller = new TasksController(create, {} as never, {} as never);

    const result = await controller.create(request, 'idem-1', 'a'.repeat(32), {
      userId: SPOOFED_USER_ID,
      quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
      capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
      parameters: { prompt: 'ocean' },
      quotedPoints: '1200',
    });

    expect(result).toMatchObject({ taskId: TASK_ID, status: 'QUEUED' });
    expect(create.execute).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID }),
      'idem-1',
      { traceId: 'a'.repeat(32) },
    );
  });

  it.each(['create', 'retry'] as const)(
    'preserves an own parameters.__proto__ JSON field through %s transport validation',
    async (operation) => {
      const body = JSON.parse(
        `{"quoteId":"0198f4d4-21c2-7b7d-8a03-08a0da2a51a3",` +
          `"capabilityVersionId":"0198f4d4-21c2-7b7d-8a03-08a0da2a51a4",` +
          `"parameters":{"__proto__":{"mode":"strict"}},"quotedPoints":"1200"}`,
      ) as unknown;
      const expectedParametersHash = createHash('sha256')
        .update('{"__proto__":{"mode":"strict"}}')
        .digest('hex');
      const create = {
        execute: vi.fn(async (command: { readonly parameters: unknown }) => {
          const receivedHash = createHash('sha256')
            .update(canonicalJson(command.parameters))
            .digest('hex');
          if (receivedHash !== expectedParametersHash) {
            throw new GenerationApplicationError('QUOTE_MISMATCH');
          }
          return { taskId: TASK_ID, status: 'QUEUED' as const, version: 2 as const };
        }),
      };
      const tasks = {
        assertRetryable: vi.fn(async () => ({ id: TASK_ID, status: 'FAILED' })),
      };
      const controller = new TasksController(create, tasks as never, {} as never);

      const result =
        operation === 'create'
          ? await controller.create(request, 'proto-idem', undefined, body)
          : await controller.retry(request, TASK_ID, 'proto-retry-idem', undefined, body);

      expect(result).toMatchObject({ status: 'QUEUED' });
      const received = create.execute.mock.calls[0]?.[0].parameters as object;
      expect(Object.getPrototypeOf(received)).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(received, '__proto__')).toBe(true);
      expect(canonicalJson(received)).toBe('{"__proto__":{"mode":"strict"}}');
    },
  );

  it('requires the frozen idempotency header on create', async () => {
    const create = { execute: vi.fn() };
    const controller = new TasksController(create, {} as never, {} as never);

    await expect(
      controller.create(request, undefined, undefined, {
        quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
        capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
        parameters: {},
        quotedPoints: '1',
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(create.execute).not.toHaveBeenCalled();
  });

  it.each([null, [], { quotedPoints: '-1' }])(
    'rejects a malformed create body before application execution',
    async (body) => {
      const create = { execute: vi.fn() };
      const controller = new TasksController(create, {} as never, {} as never);

      await expect(controller.create(request, 'idem-1', undefined, body)).rejects.toMatchObject({
        status: 400,
      });
      expect(create.execute).not.toHaveBeenCalled();
    },
  );

  it('rejects non-scalar transport headers and query values', async () => {
    const create = { execute: vi.fn() };
    const tasks = { list: vi.fn() };
    const controller = new TasksController(create, tasks as never, {} as never);
    const validBody = {
      quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
      capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
      parameters: {},
      quotedPoints: '1',
    };

    await expect(
      controller.create(request, ['idem-1'] as never, undefined, validBody),
    ).rejects.toMatchObject({ status: 400 });
    await expect(controller.list(request, undefined, ['1'] as never)).rejects.toMatchObject({
      status: 400,
    });
    expect(create.execute).not.toHaveBeenCalled();
    expect(tasks.list).not.toHaveBeenCalled();
  });

  it('rejects malformed route UUIDs before ownership persistence', async () => {
    const tasks = { get: vi.fn(), cancel: vi.fn(), assertRetryable: vi.fn() };
    const controller = new TasksController({ execute: vi.fn() }, tasks as never, {} as never);

    await expect(controller.get(request, 'not-a-task')).rejects.toMatchObject({ status: 400 });
    await expect(controller.cancel(request, 'not-a-task')).rejects.toMatchObject({ status: 400 });
    expect(tasks.get).not.toHaveBeenCalled();
    expect(tasks.cancel).not.toHaveBeenCalled();
  });

  it('retries by creating a new quoted task with authenticated ownership', async () => {
    const create = {
      execute: vi.fn(async () => ({
        taskId: TASK_ID,
        status: 'QUEUED' as const,
        version: 2 as const,
      })),
    };
    const tasks = { assertRetryable: vi.fn(async () => ({ id: TASK_ID, status: 'FAILED' })) };
    const controller = new TasksController(create, tasks as never, {} as never);

    await expect(
      controller.retry(request, TASK_ID, 'retry-idem-1', 'b'.repeat(32), {
        userId: SPOOFED_USER_ID,
        quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a3',
        capabilityVersionId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a4',
        parameters: { prompt: 'retry with a new quote' },
        quotedPoints: '1300',
      }),
    ).resolves.toMatchObject({ status: 'QUEUED', version: 2 });
    expect(tasks.assertRetryable).toHaveBeenCalledWith(USER_ID, TASK_ID);
    expect(create.execute).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER_ID, quotedPoints: '1300' }),
      'retry-idem-1',
      { traceId: 'b'.repeat(32) },
    );
  });

  it.each([
    { key: undefined, body: {} },
    { key: 'retry-idem-1', body: null },
  ])('rejects a retry without a valid new command and idempotency key', async ({ key, body }) => {
    const create = { execute: vi.fn() };
    const tasks = { assertRetryable: vi.fn() };
    const controller = new TasksController(create, tasks as never, {} as never);

    await expect(controller.retry(request, TASK_ID, key, undefined, body)).rejects.toMatchObject({
      status: 400,
    });
    expect(tasks.assertRetryable).not.toHaveBeenCalled();
    expect(create.execute).not.toHaveBeenCalled();
  });

  it('checks ownership before opening a replayable transition stream', async () => {
    const management = { get: vi.fn(async () => ({ id: TASK_ID })) };
    const stream: TaskEventStreamPort = {
      stream: vi.fn(() =>
        of({
          transitionId: TRANSITION_ID,
          taskId: TASK_ID,
          taskVersion: 3,
          status: 'RUNNING' as const,
          occurredAt: '2026-08-31T08:00:00.000Z',
        }),
      ),
    };
    const events = new TaskEventsService(management, stream);

    const message = await firstValueFrom(
      await events.stream(USER_ID, TASK_ID, `2:${TRANSITION_ID}`),
    );

    expect(management.get).toHaveBeenCalledWith(USER_ID, TASK_ID);
    expect(stream.stream).toHaveBeenCalledWith({
      taskId: TASK_ID,
      after: { taskVersion: 2, transitionId: TRANSITION_ID },
    });
    expect(message).toMatchObject({
      id: `3:${TRANSITION_ID}`,
      type: 'task-transition',
      data: { taskId: TASK_ID, status: 'RUNNING' },
    });
  });

  it('rejects malformed Last-Event-ID before ownership or stream access', async () => {
    const management = { get: vi.fn() };
    const stream: TaskEventStreamPort = { stream: vi.fn(() => of()) };
    const events = new TaskEventsService(management, stream);

    await expect(events.stream(USER_ID, TASK_ID, 'not-a-transition-cursor')).rejects.toMatchObject({
      code: 'INVALID_CURSOR',
    });
    expect(management.get).not.toHaveBeenCalled();
    expect(stream.stream).not.toHaveBeenCalled();
  });

  it('returns a stable not-found before a non-owner SSE observable is created', async () => {
    const management = {
      get: vi.fn(async () => {
        throw new GenerationApplicationError('TASK_NOT_FOUND');
      }),
    };
    const stream: TaskEventStreamPort = { stream: vi.fn(() => of()) };
    const events = new TaskEventsService(management, stream);
    const controller = new TasksController({ execute: vi.fn() }, {} as never, events);

    await expect(controller.streamEvents(request, TASK_ID, undefined)).rejects.toMatchObject({
      code: 'TASK_NOT_FOUND',
    });
    expect(stream.stream).not.toHaveBeenCalled();
  });
});
