import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Sse,
  UseFilters,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import { HEADERS, UuidSchema } from '@repo/contracts/common';
import { map, type Observable } from 'rxjs';
import type {
  CreateTaskCommand,
  CreateTaskPersistence,
} from '../application/create-task.service.js';
import type { TaskEventsService } from '../application/task-events.service.js';
import type {
  TaskCommandResult,
  TaskListResult,
  TaskManagementService,
  OwnedTask,
} from '../application/task-management.service.js';
import { GenerationExceptionFilter } from './generation-exception.filter.js';
import { AuthenticatedPrincipalGuard } from './authenticated-principal.guard.js';
import { CREATE_TASKS, TASK_EVENTS, TASK_MANAGEMENT } from './tokens.js';
import { parseTransportTaskCommand } from './task-command.parser.js';

export interface AuthenticatedRequest {
  readonly principal: { readonly userId: string };
}

export interface CreateTaskExecutor {
  execute(
    command: CreateTaskCommand,
    idempotencyKey: string,
    context?: { readonly traceId?: string },
  ): Promise<CreateTaskPersistence>;
}

function traceId(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/.test(value)
    ? value
    : randomBytes(16).toString('hex');
}

function invalidRequest(incomingTraceId?: unknown): BadRequestException {
  return new BadRequestException({
    code: 'INVALID_TASK_REQUEST',
    message: 'The task request is invalid.',
    retryable: false,
    traceId: traceId(incomingTraceId),
  });
}

function parseCommand(body: unknown, userId: string, incomingTraceId?: unknown): CreateTaskCommand {
  const command = parseTransportTaskCommand(body, userId);
  if (command === null) throw invalidRequest(incomingTraceId);
  return command;
}

function requireIdempotencyKey(value: unknown, incomingTraceId?: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 160 ||
    value.trim() !== value
  ) {
    throw new BadRequestException({
      code: 'INVALID_IDEMPOTENCY_KEY',
      message: 'A valid idempotency key is required.',
      retryable: false,
      traceId: traceId(incomingTraceId),
    });
  }
  return value;
}

function requireTaskId(value: unknown, incomingTraceId?: unknown): string {
  const parsed = UuidSchema.safeParse(value);
  if (!parsed.success) throw invalidRequest(incomingTraceId);
  return parsed.data;
}

@Controller('v1/tasks')
@UseFilters(GenerationExceptionFilter)
@UseGuards(AuthenticatedPrincipalGuard)
export class TasksController {
  constructor(
    @Inject(CREATE_TASKS)
    private readonly createTasks: CreateTaskExecutor,
    @Inject(TASK_MANAGEMENT)
    private readonly tasks: TaskManagementService,
    @Inject(TASK_EVENTS)
    private readonly events: TaskEventsService,
  ) {}

  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  async create(
    @Req() request: AuthenticatedRequest,
    @Headers(HEADERS.idempotencyKey) idempotencyKey: unknown,
    @Headers(HEADERS.traceId) incomingTraceId: unknown,
    @Body() body: unknown,
  ): Promise<CreateTaskPersistence> {
    return this.createTasks.execute(
      parseCommand(body, request.principal.userId, incomingTraceId),
      requireIdempotencyKey(idempotencyKey, incomingTraceId),
      { traceId: traceId(incomingTraceId) },
    );
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query('cursor') cursor?: unknown,
    @Query('limit') rawLimit?: unknown,
  ): Promise<TaskListResult> {
    if (cursor !== undefined && typeof cursor !== 'string') throw invalidRequest();
    if (rawLimit !== undefined && (typeof rawLimit !== 'string' || !/^[1-9]\d*$/.test(rawLimit))) {
      throw invalidRequest();
    }
    const limit = rawLimit === undefined ? undefined : Number(rawLimit);
    if (limit !== undefined && limit > 100) throw invalidRequest();
    const input = {
      ...(cursor === undefined ? {} : { cursor }),
      ...(limit === undefined ? {} : { limit }),
    };
    return this.tasks.list(request.principal.userId, input);
  }

  @Get(':id')
  async get(
    @Req() request: AuthenticatedRequest,
    @Param('id') taskId: unknown,
  ): Promise<OwnedTask> {
    return this.tasks.get(request.principal.userId, requireTaskId(taskId));
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.ACCEPTED)
  async cancel(
    @Req() request: AuthenticatedRequest,
    @Param('id') taskId: unknown,
    @Headers(HEADERS.traceId) incomingTraceId?: unknown,
  ): Promise<TaskCommandResult> {
    return this.tasks.cancel(
      request.principal.userId,
      requireTaskId(taskId, incomingTraceId),
      traceId(incomingTraceId),
    );
  }

  @Post(':id/retry')
  @HttpCode(HttpStatus.ACCEPTED)
  async retry(
    @Req() request: AuthenticatedRequest,
    @Param('id') taskId: unknown,
    @Headers(HEADERS.idempotencyKey) idempotencyKey: unknown,
    @Headers(HEADERS.traceId) incomingTraceId: unknown,
    @Body() body: unknown,
  ): Promise<CreateTaskPersistence> {
    const ownedTaskId = requireTaskId(taskId, incomingTraceId);
    const command = parseCommand(body, request.principal.userId, incomingTraceId);
    const key = requireIdempotencyKey(idempotencyKey, incomingTraceId);
    await this.tasks.assertRetryable(request.principal.userId, ownedTaskId);
    return this.createTasks.execute(command, key, { traceId: traceId(incomingTraceId) });
  }

  @Sse(':id/events')
  async streamEvents(
    @Req() request: AuthenticatedRequest,
    @Param('id') taskId: unknown,
    @Headers('last-event-id') lastEventId?: unknown,
  ): Promise<Observable<MessageEvent>> {
    if (lastEventId !== undefined && typeof lastEventId !== 'string') throw invalidRequest();
    const stream = await this.events.stream(
      request.principal.userId,
      requireTaskId(taskId),
      lastEventId,
    );
    return stream.pipe(map((event) => ({ id: event.id, type: event.type, data: event.data })));
  }
}
