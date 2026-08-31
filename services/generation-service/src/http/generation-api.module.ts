import { type DynamicModule, Module } from '@nestjs/common';
import type { TaskEventsService } from '../application/task-events.service.js';
import type { TaskManagementService } from '../application/task-management.service.js';
import { AuthenticatedPrincipalGuard } from './authenticated-principal.guard.js';
import { GenerationExceptionFilter } from './generation-exception.filter.js';
import { TasksController, type CreateTaskExecutor } from './tasks.controller.js';
import { CREATE_TASKS, TASK_EVENTS, TASK_MANAGEMENT } from './tokens.js';

interface GenerationApiDependencies {
  readonly createTasks: CreateTaskExecutor;
  readonly tasks: TaskManagementService;
  readonly events: TaskEventsService;
}

@Module({})
// Nest modules are declarative classes; register supplies the runtime providers.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
export class GenerationApiModule {
  static register(dependencies: GenerationApiDependencies): DynamicModule {
    return {
      module: GenerationApiModule,
      controllers: [TasksController],
      providers: [
        AuthenticatedPrincipalGuard,
        GenerationExceptionFilter,
        { provide: CREATE_TASKS, useValue: dependencies.createTasks },
        { provide: TASK_MANAGEMENT, useValue: dependencies.tasks },
        { provide: TASK_EVENTS, useValue: dependencies.events },
      ],
    };
  }
}
