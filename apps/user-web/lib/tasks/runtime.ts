import { TaskStatusSchema } from '@repo/contracts/generation';

import type {
  RetryDraft,
  TaskDetail,
  TaskFilters,
  TaskGenerationMode,
  TaskPage,
  TaskParameterSnapshotItem,
  TaskStatus,
  TaskStatusSnapshot,
  TaskSummary,
  TaskTimelineItem,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(code);
  return value;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(code);
  return value;
}

function assertOnlyKeys(
  record: Record<string, unknown>,
  allowed: readonly string[],
  code: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) throw new Error(code);
}

function parsePoints(value: unknown): string {
  const points = requireString(value, 'INVALID_TASK_POINTS');
  if (!/^\d+$/.test(points)) throw new Error('INVALID_TASK_POINTS');
  return points;
}

function parseGenerationMode(value: unknown): TaskGenerationMode {
  if (
    value !== 'TEXT_TO_VIDEO' &&
    value !== 'IMAGE_TO_VIDEO' &&
    value !== 'FIRST_LAST_FRAME' &&
    value !== 'REFERENCE_VIDEO' &&
    value !== 'EXTEND_VIDEO'
  ) {
    throw new Error('INVALID_TASK_GENERATION_MODE');
  }
  return value;
}

function parseRevision(record: Record<string, unknown>): number {
  const revision = record.revision ?? record.sequence;
  if (
    !Number.isSafeInteger(revision) ||
    (revision as number) < 0 ||
    (record.revision !== undefined &&
      record.sequence !== undefined &&
      record.revision !== record.sequence)
  ) {
    throw new Error('INVALID_TASK_REVISION');
  }
  return revision as number;
}

function parseIsoInstant(value: unknown): string {
  const instant = requireString(value, 'INVALID_TASK_UPDATED_AT');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{3}))?Z$/.exec(instant);
  const parsed = Date.parse(instant);
  if (!match || !Number.isFinite(parsed)) {
    throw new Error('INVALID_TASK_UPDATED_AT');
  }
  const date = new Date(parsed);
  const parts = [
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
    date.getUTCMilliseconds(),
  ];
  const expected = [...match.slice(1, 7).map((part) => Number(part)), Number(match[7] || '0')];
  if (parts.some((part, index) => part !== expected[index])) {
    throw new Error('INVALID_TASK_UPDATED_AT');
  }
  return instant;
}

export function parseTaskStatusSnapshot(
  value: unknown,
  transportEventId?: string,
): TaskStatusSnapshot {
  const record = requireRecord(value, 'INVALID_TASK_STATUS_EVENT');
  assertOnlyKeys(
    record,
    [
      'eventId',
      'revision',
      'sequence',
      'status',
      'terminal',
      'cancelAllowed',
      'updatedAt',
      'publicReason',
    ],
    'UNKNOWN_TASK_STATUS_FIELD',
  );
  const eventId = requireString(record.eventId, 'INVALID_TASK_EVENT_ID');
  if (transportEventId !== undefined && transportEventId !== eventId) {
    throw new Error('TASK_EVENT_ID_MISMATCH');
  }
  const parsedStatus = TaskStatusSchema.safeParse(record.status);
  if (!parsedStatus.success) throw new Error('INVALID_TASK_STATUS');
  if (typeof record.terminal !== 'boolean' || typeof record.cancelAllowed !== 'boolean') {
    throw new Error('INVALID_TASK_STATUS_FLAGS');
  }
  let publicReason: TaskStatusSnapshot['publicReason'];
  if (record.publicReason !== undefined) {
    const reason = requireRecord(record.publicReason, 'INVALID_TASK_PUBLIC_REASON');
    assertOnlyKeys(reason, ['code', 'message'], 'UNKNOWN_TASK_PUBLIC_REASON_FIELD');
    publicReason = {
      code: requireString(reason.code, 'INVALID_TASK_PUBLIC_REASON_CODE'),
      message: requireString(reason.message, 'INVALID_TASK_PUBLIC_REASON_MESSAGE'),
    };
  }
  return {
    eventId,
    revision: parseRevision(record),
    status: parsedStatus.data,
    terminal: record.terminal,
    cancelAllowed: record.cancelAllowed,
    updatedAt: parseIsoInstant(record.updatedAt),
    ...(publicReason ? { publicReason } : {}),
  };
}

function parseParameterSummary(value: unknown): readonly TaskParameterSnapshotItem[] {
  if (!Array.isArray(value)) throw new Error('INVALID_TASK_PARAMETER_SUMMARY');
  return value.map((rawItem) => {
    const item = requireRecord(rawItem, 'INVALID_TASK_PARAMETER_SUMMARY_ITEM');
    assertOnlyKeys(item, ['key', 'label', 'value'], 'UNKNOWN_TASK_PARAMETER_SUMMARY_FIELD');
    return {
      key: requireString(item.key, 'INVALID_TASK_PARAMETER_KEY'),
      label: requireString(item.label, 'INVALID_TASK_PARAMETER_LABEL'),
      value: requireString(item.value, 'INVALID_TASK_PARAMETER_VALUE'),
    };
  });
}

const TASK_SUMMARY_KEYS = [
  'id',
  'taskNumber',
  'statusSnapshot',
  'generationMode',
  'modelName',
  'providerName',
  'createdAt',
  'quotedPoints',
] as const;

function parseTaskSummary(value: unknown, nestedInDetail = false): TaskSummary {
  const task = requireRecord(value, 'INVALID_TASK_SUMMARY');
  if (!nestedInDetail) {
    assertOnlyKeys(task, TASK_SUMMARY_KEYS, 'UNKNOWN_TASK_SUMMARY_FIELD');
  }
  return {
    id: requireString(task.id, 'INVALID_TASK_ID'),
    taskNumber: requireString(task.taskNumber, 'INVALID_TASK_NUMBER'),
    statusSnapshot: parseTaskStatusSnapshot(task.statusSnapshot),
    generationMode: parseGenerationMode(task.generationMode),
    modelName: requireString(task.modelName, 'INVALID_TASK_MODEL_NAME'),
    providerName: requireString(task.providerName, 'INVALID_TASK_PROVIDER_NAME'),
    createdAt: parseIsoInstant(task.createdAt),
    quotedPoints: parsePoints(task.quotedPoints),
  };
}

export function parseTaskPage(value: unknown): TaskPage {
  const page = requireRecord(value, 'INVALID_TASK_PAGE');
  assertOnlyKeys(page, ['items', 'pageInfo'], 'UNKNOWN_TASK_PAGE_FIELD');
  if (!Array.isArray(page.items)) throw new Error('INVALID_TASK_ITEMS');
  const pageInfo = requireRecord(page.pageInfo, 'INVALID_TASK_PAGE_INFO');
  assertOnlyKeys(pageInfo, ['previousCursor', 'nextCursor'], 'UNKNOWN_TASK_PAGE_INFO_FIELD');
  const previousCursor =
    pageInfo.previousCursor === undefined
      ? undefined
      : requireString(pageInfo.previousCursor, 'INVALID_TASK_CURSOR');
  const nextCursor =
    pageInfo.nextCursor === undefined
      ? undefined
      : requireString(pageInfo.nextCursor, 'INVALID_TASK_CURSOR');
  return {
    items: page.items.map((item) => parseTaskSummary(item)),
    pageInfo: {
      ...(previousCursor ? { previousCursor } : {}),
      ...(nextCursor ? { nextCursor } : {}),
    },
  };
}

export function parseTaskDetail(value: unknown): TaskDetail {
  const task = requireRecord(value, 'INVALID_TASK_DETAIL');
  assertOnlyKeys(
    task,
    [
      ...TASK_SUMMARY_KEYS,
      'modelSnapshot',
      'parametersSnapshot',
      'parameterSummary',
      'financial',
      'timeline',
    ],
    'UNKNOWN_TASK_DETAIL_FIELD',
  );
  const summary = parseTaskSummary(task, true);
  const model = requireRecord(task.modelSnapshot, 'INVALID_TASK_MODEL_SNAPSHOT');
  assertOnlyKeys(
    model,
    ['modelId', 'modelName', 'providerId', 'providerName', 'capabilityVersion', 'pricingVersion'],
    'UNKNOWN_TASK_MODEL_SNAPSHOT_FIELD',
  );
  const parametersSnapshot = requireRecord(
    task.parametersSnapshot,
    'INVALID_TASK_PARAMETERS_SNAPSHOT',
  );
  const financial = requireRecord(task.financial, 'INVALID_TASK_FINANCIAL_STATE');
  assertOnlyKeys(
    financial,
    ['availablePoints', 'frozenPoints', 'settledPoints', 'refundedPoints'],
    'UNKNOWN_TASK_FINANCIAL_FIELD',
  );
  if (!Array.isArray(task.timeline)) throw new Error('INVALID_TASK_TIMELINE');
  const timeline: readonly TaskTimelineItem[] = task.timeline.map((rawItem) => {
    const item = requireRecord(rawItem, 'INVALID_TASK_TIMELINE_ITEM');
    const { label: rawLabel, ...statusFields } = item;
    return {
      ...parseTaskStatusSnapshot(statusFields),
      label: requireString(rawLabel, 'INVALID_TASK_TIMELINE_LABEL'),
    };
  });
  return {
    ...summary,
    modelSnapshot: {
      modelId: requireString(model.modelId, 'INVALID_TASK_MODEL_ID'),
      modelName: requireString(model.modelName, 'INVALID_TASK_MODEL_NAME'),
      providerId: requireString(model.providerId, 'INVALID_TASK_PROVIDER_ID'),
      providerName: requireString(model.providerName, 'INVALID_TASK_PROVIDER_NAME'),
      capabilityVersion: requireString(model.capabilityVersion, 'INVALID_TASK_CAPABILITY_VERSION'),
      pricingVersion: requireString(model.pricingVersion, 'INVALID_TASK_PRICING_VERSION'),
    },
    parametersSnapshot: { ...parametersSnapshot },
    parameterSummary: parseParameterSummary(task.parameterSummary),
    financial: {
      availablePoints: parsePoints(financial.availablePoints),
      frozenPoints: parsePoints(financial.frozenPoints),
      settledPoints: parsePoints(financial.settledPoints),
      refundedPoints: parsePoints(financial.refundedPoints),
    },
    timeline,
  };
}

export function parseRetryDraft(value: unknown): { readonly draftId: string } {
  const draft = requireRecord(value, 'INVALID_RETRY_DRAFT');
  assertOnlyKeys(draft, ['draftId'], 'UNKNOWN_RETRY_DRAFT_FIELD');
  return { draftId: requireString(draft.draftId, 'INVALID_RETRY_DRAFT_ID') };
}

export function parseStoredRetryDraft(value: unknown): RetryDraft {
  const draft = requireRecord(value, 'INVALID_RETRY_DRAFT');
  assertOnlyKeys(
    draft,
    ['id', 'generationMode', 'modelId', 'capabilityVersion', 'parameters'],
    'UNKNOWN_RETRY_DRAFT_FIELD',
  );
  return {
    id: requireString(draft.id, 'INVALID_RETRY_DRAFT_ID'),
    generationMode: parseGenerationMode(draft.generationMode),
    modelId: requireString(draft.modelId, 'INVALID_RETRY_MODEL_ID'),
    capabilityVersion: requireString(draft.capabilityVersion, 'INVALID_RETRY_CAPABILITY_VERSION'),
    parameters: { ...requireRecord(draft.parameters, 'INVALID_RETRY_PARAMETERS') },
  };
}

export function formatPoints(points: string): string {
  return BigInt(parsePoints(points)).toLocaleString('en-US');
}

const TASK_DATE_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  minute: '2-digit',
  month: '2-digit',
  second: '2-digit',
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
});

export function formatTaskDate(instant: string): string {
  const parts = new Map<string, string>(
    TASK_DATE_FORMATTER.formatToParts(new Date(parseIsoInstant(instant))).map((part) => [
      part.type,
      part.value,
    ]),
  );
  const part = (type: string): string => {
    const value = parts.get(type);
    if (!value) throw new Error('INVALID_TASK_DATE_FORMAT');
    return value;
  };
  return `${part('year')}-${part('month')}-${part('day')} ${part('hour')}:${part('minute')}:${part('second')}`;
}

export function parseTaskFilters(
  value: Record<string, string | string[] | undefined>,
): TaskFilters {
  const scalar = (key: string) => {
    const raw = value[key];
    return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
  };
  const statusValue = scalar('status');
  let status: TaskStatus | undefined;
  if (statusValue !== undefined) {
    const parsed = TaskStatusSchema.safeParse(statusValue);
    if (!parsed.success) throw new Error('INVALID_TASK_FILTER_STATUS');
    status = parsed.data;
  }
  const timeValue = scalar('time');
  if (timeValue && !['TODAY', 'LAST_7_DAYS', 'LAST_30_DAYS'].includes(timeValue)) {
    throw new Error('INVALID_TASK_FILTER_TIME');
  }
  const modeValue = scalar('generationMode');
  const generationMode = modeValue ? parseGenerationMode(modeValue) : undefined;
  const model = scalar('model');
  const taskNumber = scalar('taskNumber');
  const cursor = scalar('cursor');
  const time = timeValue as 'TODAY' | 'LAST_7_DAYS' | 'LAST_30_DAYS' | undefined;
  return {
    ...(status ? { status } : {}),
    ...(time ? { time } : {}),
    ...(model ? { model } : {}),
    ...(generationMode ? { generationMode } : {}),
    ...(taskNumber ? { taskNumber } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

export function reduceStatus(
  current: TaskStatusSnapshot,
  incoming: TaskStatusSnapshot,
): TaskStatusSnapshot {
  if (current.terminal || incoming.revision <= current.revision) return current;
  return incoming;
}
