import { saveRetryDraft } from '../studio/retry-drafts';
import {
  cancelMockCommercialTask,
  listMockCommercialTasks,
  readMockCommercialTask,
} from '../studio/mock-commercial-store';
import { createUuidV7, isUuidV7 } from './identifiers';
import type {
  RetryDraft,
  TaskDetail,
  TaskFilters,
  TaskGateway,
  TaskPage,
  TaskStatusSnapshot,
} from './types';

export class TaskGatewayCommandError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;
}

export function classifyCancelTaskError(error: unknown): 'UNCERTAIN' | 'DEFINITIVE_FAILURE' {
  return error instanceof TaskGatewayCommandError ||
    (typeof error === 'object' &&
      error !== null &&
      'outcome' in error &&
      error.outcome === 'DEFINITIVE_FAILURE')
    ? 'DEFINITIVE_FAILURE'
    : 'UNCERTAIN';
}

const fixtureCursor = (revision: number, suffix: string) =>
  `${String(revision)}:0198f4d4-21c2-7b7d-8a03-${suffix}`;

type OwnedTaskDetail = TaskDetail & { readonly ownerId: string };

const FIXTURE_OWNER_A = '0198f4d4-21c2-7b7d-8a03-08a0da2a7401';

const fixtures: readonly OwnedTaskDetail[] = [
  {
    ownerId: FIXTURE_OWNER_A,
    id: 'task-1',
    taskNumber: 'T20260831-0001',
    generationMode: 'IMAGE_TO_VIDEO',
    modelName: 'Cinema V2',
    providerName: '演示平台 East',
    createdAt: '2026-08-31T10:00:00.000Z',
    quotedPoints: '240',
    statusSnapshot: {
      eventId: fixtureCursor(4, '08a0da2a5104'),
      revision: 4,
      status: 'RUNNING',
      terminal: false,
      cancelAllowed: true,
      updatedAt: '2026-08-31T10:04:00.000Z',
    },
    modelSnapshot: {
      modelId: 'mock-cinema-v2',
      modelName: 'Cinema V2',
      providerId: 'mock-provider-east',
      providerName: '演示平台 East',
      capabilityVersion: 'cap-image-v7',
      pricingVersion: 'pricing-2026-08-31',
    },
    parametersSnapshot: {
      image: 'asset-21',
      duration: 5,
      motion: 'natural',
    },
    parameterSummary: [
      { key: 'image', label: '起始图片', value: '素材 #A-21' },
      { key: 'duration', label: '时长', value: '5 秒' },
      { key: 'motion', label: '运动模式', value: '自然运动' },
    ],
    financial: {
      availablePoints: '9007199254740993',
      frozenPoints: '240',
      settledPoints: '0',
      refundedPoints: '0',
    },
    timeline: [
      {
        eventId: fixtureCursor(1, '08a0da2a5101'),
        revision: 1,
        status: 'QUEUED',
        terminal: false,
        cancelAllowed: true,
        updatedAt: '2026-08-31T10:00:00.000Z',
        label: '任务已进入队列',
      },
      {
        eventId: fixtureCursor(4, '08a0da2a5104'),
        revision: 4,
        status: 'RUNNING',
        terminal: false,
        cancelAllowed: true,
        updatedAt: '2026-08-31T10:04:00.000Z',
        label: '生成服务正在处理',
      },
    ],
  },
  {
    ownerId: FIXTURE_OWNER_A,
    id: 'task-2',
    taskNumber: 'T20260831-0002',
    generationMode: 'TEXT_TO_VIDEO',
    modelName: 'Story V3',
    providerName: '演示平台 West',
    createdAt: '2026-08-31T09:00:00.000Z',
    quotedPoints: '300',
    statusSnapshot: {
      eventId: fixtureCursor(9, '08a0da2a5209'),
      revision: 9,
      status: 'SETTLED',
      terminal: true,
      cancelAllowed: false,
      updatedAt: '2026-08-31T09:12:00.000Z',
    },
    modelSnapshot: {
      modelId: 'mock-story-v3',
      modelName: 'Story V3',
      providerId: 'mock-provider-west',
      providerName: '演示平台 West',
      capabilityVersion: 'cap-text-v4',
      pricingVersion: 'pricing-2026-08-31',
    },
    parametersSnapshot: { prompt: '日落下的海边公路', duration: 5, aspectRatio: '16:9' },
    parameterSummary: [
      { key: 'prompt', label: '画面描述', value: '日落下的海边公路' },
      { key: 'duration', label: '时长', value: '5 秒' },
      { key: 'aspectRatio', label: '画面比例', value: '16:9' },
    ],
    financial: {
      availablePoints: '1800',
      frozenPoints: '0',
      settledPoints: '300',
      refundedPoints: '0',
    },
    timeline: [
      {
        eventId: fixtureCursor(9, '08a0da2a5209'),
        revision: 9,
        status: 'SETTLED',
        terminal: true,
        cancelAllowed: false,
        updatedAt: '2026-08-31T09:12:00.000Z',
        label: '任务已结算',
      },
    ],
  },
  {
    ownerId: FIXTURE_OWNER_A,
    id: 'task-3',
    taskNumber: 'T20260830-0018',
    generationMode: 'REFERENCE_VIDEO',
    modelName: 'Cinema V2',
    providerName: '演示平台 East',
    createdAt: '2026-08-30T12:00:00.000Z',
    quotedPoints: '420',
    statusSnapshot: {
      eventId: fixtureCursor(7, '08a0da2a5307'),
      revision: 7,
      status: 'FAILED',
      terminal: false,
      cancelAllowed: false,
      updatedAt: '2026-08-30T12:07:00.000Z',
      publicReason: { code: 'GENERATION_FAILED', message: '本次生成未完成，点数正在退回。' },
    },
    modelSnapshot: {
      modelId: 'mock-cinema-v2',
      modelName: 'Cinema V2',
      providerId: 'mock-provider-east',
      providerName: '演示平台 East',
      capabilityVersion: 'cap-video-v1',
      pricingVersion: 'pricing-2026-08-30',
    },
    parametersSnapshot: { sourceAsset: 'asset-18', prompt: '节奏更快', duration: 5 },
    parameterSummary: [
      { key: 'sourceAsset', label: '参考素材', value: '素材 #A-18' },
      { key: 'prompt', label: '画面描述', value: '节奏更快' },
    ],
    financial: {
      availablePoints: '1380',
      frozenPoints: '420',
      settledPoints: '0',
      refundedPoints: '0',
    },
    timeline: [
      {
        eventId: fixtureCursor(7, '08a0da2a5307'),
        revision: 7,
        status: 'FAILED',
        terminal: false,
        cancelAllowed: false,
        updatedAt: '2026-08-30T12:07:00.000Z',
        publicReason: { code: 'GENERATION_FAILED', message: '本次生成未完成，点数正在退回。' },
        label: '生成未完成，等待退款',
      },
    ],
  },
];

const cursorOffsets = new Map<string, number>([
  ['eyJwYWdlIjoxfQ', 0],
  ['eyJwYWdlIjoyfQ', 2],
]);
const PAGE_SIZE = 2;
const CANCEL_CACHE_TTL_MS = 10 * 60 * 1_000;
const MAX_CANCEL_CACHE_ENTRIES = 100;
const canceledByKey = new Map<
  string,
  {
    readonly expiresAt: number;
    readonly fingerprint: string;
    readonly ownerId: string;
    readonly snapshot: TaskStatusSnapshot;
    readonly taskId: string;
  }
>();

function sweepCanceledCache(now: number): void {
  for (const [key, entry] of canceledByKey) {
    if (entry.expiresAt <= now) canceledByKey.delete(key);
  }
}

function matches(task: TaskDetail, filters: TaskFilters): boolean {
  if (filters.status && task.statusSnapshot.status !== filters.status) return false;
  if (filters.model && task.modelSnapshot.modelId !== filters.model) return false;
  if (filters.generationMode && task.generationMode !== filters.generationMode) return false;
  if (filters.taskNumber && !task.taskNumber.includes(filters.taskNumber)) return false;
  if (filters.time === 'TODAY' && !task.createdAt.startsWith('2026-08-31')) return false;
  if (filters.time === 'LAST_7_DAYS' && task.createdAt < '2026-08-25') return false;
  if (filters.time === 'LAST_30_DAYS' && task.createdAt < '2026-08-02') return false;
  return true;
}

function toSummary(task: TaskDetail): TaskPage['items'][number] {
  return {
    id: task.id,
    taskNumber: task.taskNumber,
    statusSnapshot: task.statusSnapshot,
    generationMode: task.generationMode,
    modelName: task.modelName,
    providerName: task.providerName,
    createdAt: task.createdAt,
    quotedPoints: task.quotedPoints,
  };
}

async function commercialTasks(ownerId: string): Promise<readonly TaskDetail[]> {
  if (process.env.USER_WEB_STUDIO_MODE !== 'mock') {
    throw new TaskGatewayCommandError('TASK_GATEWAY_UNAVAILABLE');
  }
  return listMockCommercialTasks(ownerId);
}

export const taskGateway: TaskGateway = {
  async listTasks(filters, context): Promise<unknown> {
    const dynamic = (await commercialTasks(context.ownerId)).filter((task) =>
      matches(task, filters),
    );
    const filtered = [
      ...dynamic,
      ...fixtures.filter((task) => task.ownerId === context.ownerId && matches(task, filters)),
    ];
    const offset = filters.cursor ? cursorOffsets.get(filters.cursor) : 0;
    if (offset === undefined) throw new Error('INVALID_TASK_CURSOR');
    const page: TaskPage = {
      items: filtered.slice(offset, offset + PAGE_SIZE).map(toSummary),
      pageInfo: {
        ...(offset > 0 ? { previousCursor: 'eyJwYWdlIjoxfQ' } : {}),
        ...(offset + PAGE_SIZE < filtered.length ? { nextCursor: 'eyJwYWdlIjoyfQ' } : {}),
      },
    };
    return Promise.resolve(structuredClone(page));
  },

  async getTask(taskId, context): Promise<unknown> {
    if (process.env.USER_WEB_STUDIO_MODE !== 'mock') {
      throw new TaskGatewayCommandError('TASK_GATEWAY_UNAVAILABLE');
    }
    const generated = await readMockCommercialTask(context.ownerId, taskId);
    if (generated) return generated;
    const task = fixtures.find(
      (candidate) => candidate.id === taskId && candidate.ownerId === context.ownerId,
    );
    if (!task) throw new Error('TASK_NOT_FOUND');
    const { ownerId, ...detail } = task;
    void ownerId;
    return Promise.resolve(structuredClone(detail));
  },

  async cancelTask(taskId, options): Promise<unknown> {
    if (process.env.USER_WEB_STUDIO_MODE !== 'mock') {
      throw new TaskGatewayCommandError('TASK_GATEWAY_UNAVAILABLE');
    }
    if (!isUuidV7(options.idempotencyKey)) {
      throw new TaskGatewayCommandError('INVALID_IDEMPOTENCY_KEY');
    }
    const now = Date.now();
    sweepCanceledCache(now);
    const generated = await readMockCommercialTask(options.ownerId, taskId);
    if (generated) {
      return cancelMockCommercialTask(options.ownerId, taskId, options.idempotencyKey);
    }
    const task = fixtures.find(
      (candidate) => candidate.id === taskId && candidate.ownerId === options.ownerId,
    );
    if (!task) throw new TaskGatewayCommandError('TASK_NOT_FOUND');
    const fingerprint = JSON.stringify({ operation: 'cancel', taskId });
    const existing = canceledByKey.get(options.idempotencyKey);
    if (existing) {
      if (
        existing.ownerId !== options.ownerId ||
        existing.taskId !== taskId ||
        existing.fingerprint !== fingerprint
      ) {
        throw new TaskGatewayCommandError('IDEMPOTENCY_CONFLICT');
      }
      return Promise.resolve(structuredClone(existing.snapshot));
    }
    if (!task.statusSnapshot.cancelAllowed) {
      throw new TaskGatewayCommandError('CANCEL_NOT_ALLOWED');
    }
    if (canceledByKey.size >= MAX_CANCEL_CACHE_ENTRIES) {
      throw new TaskGatewayCommandError('IDEMPOTENCY_CAPACITY_REACHED');
    }
    const canceled: TaskStatusSnapshot = {
      eventId: `${String(task.statusSnapshot.revision + 1)}:${createUuidV7(now)}`,
      revision: task.statusSnapshot.revision + 1,
      status: 'CANCELED',
      terminal: false,
      cancelAllowed: false,
      updatedAt: new Date(now).toISOString(),
      publicReason: {
        code: 'USER_CANCELED',
        message: '取消请求已接受，费用将按任务快照规则处理。',
      },
    };
    canceledByKey.set(options.idempotencyKey, {
      expiresAt: now + CANCEL_CACHE_TTL_MS,
      fingerprint,
      ownerId: options.ownerId,
      snapshot: canceled,
      taskId,
    });
    return Promise.resolve(structuredClone(canceled));
  },

  async createRetryDraft(taskId, options): Promise<unknown> {
    if (process.env.USER_WEB_STUDIO_MODE !== 'mock') {
      throw new TaskGatewayCommandError('TASK_GATEWAY_UNAVAILABLE');
    }
    const task =
      (await readMockCommercialTask(options.ownerId, taskId)) ??
      fixtures.find(
        (candidate) => candidate.id === taskId && candidate.ownerId === options.ownerId,
      );
    if (!task) throw new Error('TASK_NOT_FOUND');
    const draft: RetryDraft = {
      id: createUuidV7(),
      generationMode: task.generationMode,
      providerId: task.modelSnapshot.providerId,
      modelId: task.modelSnapshot.modelId,
      capabilityVersion: task.modelSnapshot.capabilityVersion,
      capabilitySchemaVersion: 202012,
      parameters: structuredClone(task.parametersSnapshot),
    };
    saveRetryDraft(draft, { ownerId: options.ownerId });
    return Promise.resolve({ draftId: draft.id });
  },
};
