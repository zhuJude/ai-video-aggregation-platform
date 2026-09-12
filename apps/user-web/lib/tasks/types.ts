import type { TaskStatusSchema } from '@repo/contracts/generation';
import type { CapabilityDocument } from '@repo/capability-schema';

export type TaskStatus = (typeof TaskStatusSchema.options)[number];

export interface TaskPublicReason {
  readonly code: string;
  readonly message: string;
}

export interface TaskStatusSnapshot {
  readonly eventId: string;
  readonly revision: number;
  readonly status: TaskStatus;
  readonly terminal: boolean;
  readonly cancelAllowed: boolean;
  readonly updatedAt: string;
  readonly publicReason?: TaskPublicReason;
}

export type CancelTaskResult =
  | { readonly ok: true; readonly snapshot: TaskStatusSnapshot }
  | {
      readonly ok: false;
      readonly outcome: 'UNCERTAIN' | 'DEFINITIVE_FAILURE';
    };

export type TaskGenerationMode = CapabilityDocument['mode'];

export interface TaskParameterSnapshotItem {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

export interface TaskSummary {
  readonly id: string;
  readonly taskNumber: string;
  readonly statusSnapshot: TaskStatusSnapshot;
  readonly generationMode: TaskGenerationMode;
  readonly modelName: string;
  readonly providerName: string;
  readonly createdAt: string;
  readonly quotedPoints: string;
}

export interface TaskTimelineItem extends TaskStatusSnapshot {
  readonly label: string;
}

export interface TaskDetail extends TaskSummary {
  readonly modelSnapshot: {
    readonly modelId: string;
    readonly modelName: string;
    readonly providerId: string;
    readonly providerName: string;
    readonly capabilityVersion: string;
    readonly pricingVersion: string;
  };
  readonly parametersSnapshot: Readonly<Record<string, unknown>>;
  readonly parameterSummary: readonly TaskParameterSnapshotItem[];
  readonly financial: {
    readonly availablePoints: string;
    readonly frozenPoints: string;
    readonly settledPoints: string;
    readonly refundedPoints: string;
  };
  readonly timeline: readonly TaskTimelineItem[];
}

export interface TaskFilters {
  readonly status?: TaskStatus;
  readonly time?: 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS';
  readonly model?: string;
  readonly generationMode?: TaskGenerationMode;
  readonly taskNumber?: string;
  readonly cursor?: string;
}

export interface TaskPage {
  readonly items: readonly TaskSummary[];
  readonly pageInfo: {
    readonly previousCursor?: string;
    readonly nextCursor?: string;
  };
}

export interface RetryDraft {
  readonly id: string;
  readonly generationMode: TaskGenerationMode;
  readonly providerId: string;
  readonly modelId: string;
  readonly capabilityVersion: string;
  readonly capabilitySchemaVersion: number;
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface TaskGateway {
  listTasks(filters: TaskFilters): Promise<unknown>;
  getTask(taskId: string): Promise<unknown>;
  cancelTask(
    taskId: string,
    options: { readonly idempotencyKey: string; readonly ownerId: string },
  ): Promise<unknown>;
  createRetryDraft(taskId: string, options: { readonly ownerId: string }): Promise<unknown>;
}
