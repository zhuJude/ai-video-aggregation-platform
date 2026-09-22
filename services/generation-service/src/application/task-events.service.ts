import { map, type Observable } from 'rxjs';
import type { TaskStatus } from '../domain/task-state-machine.js';
import { GenerationApplicationError } from './errors.js';

export interface TransitionCursor {
  readonly taskVersion: number;
  readonly transitionId: string;
}

export interface TaskTransitionEvent {
  readonly transitionId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly status: TaskStatus;
  readonly occurredAt: string;
}

export interface TaskSseMessage {
  readonly id: string;
  readonly type: 'task-transition';
  readonly data: TaskTransitionEvent;
}

export interface TaskEventStreamPort {
  stream(input: {
    readonly taskId: string;
    readonly after?: TransitionCursor;
  }): Observable<TaskTransitionEvent>;
}

export interface OwnedTaskReader {
  get(userId: string, taskId: string): Promise<unknown>;
}

const cursorPattern =
  /^(0|[1-9]\d*):([0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

function decodeCursor(value: string | undefined): TransitionCursor | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const match = cursorPattern.exec(value);
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new GenerationApplicationError('INVALID_CURSOR');
  }
  const taskVersion = Number(match[1]);
  if (!Number.isSafeInteger(taskVersion)) throw new GenerationApplicationError('INVALID_CURSOR');
  return { taskVersion, transitionId: match[2] };
}

export class TaskEventsService {
  constructor(
    private readonly tasks: OwnedTaskReader,
    private readonly events: TaskEventStreamPort,
  ) {}

  async stream(
    userId: string,
    taskId: string,
    lastEventId?: string,
  ): Promise<Observable<TaskSseMessage>> {
    const after = decodeCursor(lastEventId);
    await this.tasks.get(userId, taskId);
    return this.events.stream(after === undefined ? { taskId } : { taskId, after }).pipe(
      map((event) => ({
        id: `${String(event.taskVersion)}:${event.transitionId}`,
        type: 'task-transition' as const,
        data: event,
      })),
    );
  }
}
