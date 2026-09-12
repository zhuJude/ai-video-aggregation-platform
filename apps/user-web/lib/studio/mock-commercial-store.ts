import 'server-only';

import { createHash } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';

import { createMockFinanceSeed } from '../commerce/gateway';
import { runMockFinanceTransaction } from '../commerce/mock-finance-store';
import { ensureMockSeedObjects } from '../commerce/mock-object-store';
import type { MutableMockFinanceState } from '../commerce/mock-finance-store';
import type { LedgerTransaction } from '../commerce/types';
import { createUuidV7, isUuidV7 } from '../tasks/identifiers';
import type { TaskDetail, TaskStatus, TaskTimelineItem } from '../tasks/types';
import { stableDeepEqual } from './runtime';
import type {
  StudioCreateTaskRequest,
  StudioQuote,
  StudioQuoteRequest,
  StudioTaskAccepted,
} from './types';

const MAX_QUOTES = 100;
const MAX_TASKS = 1_000;
// Auditable 64x64 H.264 color-card clip generated locally with Chromium MediaRecorder.
// Keeping the complete ISO-BMFF payload inline avoids public/demo media leaking into storage tests.
const MOCK_RESULT_MP4_BASE64 =
  'AAAAJGZ0eXBpc29tAAACAGlzb21pc282aXNvMmF2YzFtcDQxAAACym1vb3YAAAB4bXZoZAEAAAAAAAAA5ss4hgAAAADmyziGAAAD6AAAAAAAAAKaAAEAAAEAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAIAAAIidHJhawAAAGh0a2hkAQAAAwAAAADmyziGAAAAAObLOIYAAAABAAAAAAAAAAAAAAKaAAAAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAQAAAAABAAAAAQAAAAAABsm1kaWEAAAAsbWRoZAEAAAAAAAAA5ss4hgAAAADmyziGAAB1MAAAAAAAAAKaVcQAAAAAAC1oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAAVFtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAlZGluZgAAAB1kcmVmAAAAAAAAAAEAAAANdXJsIAAAAAEAAAABEHN0YmwAAAAQc3RzYwAAAAAAAAAAAAAAEHN0dHMAAAAAAAAAAAAAABRzdHN6AAAAAAAAAAAAAAAAAAAAEHN0Y28AAAAAAAAAAAAAAMRzdHNkAAAAAAAAAAEAAAC0YXZjMQAAAAAAAAABAAAAAQAAAAAAAAAAAAAAAABAAEAASAAAAEgAAAAAAAAAAQtBVkMxIENvZGluZwAAAAAAAAAAAAAAAAAAAAAAAAAAABj//wAAABBwYXNwAAAAAQAAAAEAAAAUYnRydAAAAAAAAAAAAAAAAAAAACdhdmNDAULACv/hABBnQsAKjGhCSagwMDA8IhGoAQAEaM48gAAAABNjb2xybmNseAAGAAYABgAAAAAobXZleAAAACB0cmV4AAAAAAAAAAEAAAABAAAAAAAAAAAAAAAAAAAAgG1vb2YAAAAQbWZoZAAAAAAAAAABAAAAaHRyYWYAAAAUdGZoZAACACAAAAABAQEAAAAAABR0ZmR0AQAAAAAAAAAAAAAAAAAAOHRydW4BAAMFAAAABAAAAIgCAAAAAAAOPwAAAE0AAB7kAAAAbwAAHQwAAABrAAAD5wAAABYAAAFFbWRhdAAAAElluAAEE///4IooABjxwABALjgACANJuTk//+IYJYoAAgU+EBKUgQCQhf/4eEYQomFbSev//AOEYQCQhQgJSk/4B/CNq663fXXgAAAAa2HgAH5BPN//8EUUAAQD/7E6xPifN//wgucDgEAUEIOAiAZ4HmK5wOkdyb/Hx0C7BwBAEU4BxaeB0h3PA8yuRfYz+b/+HBUykWqHmK54dIdzzf4BgGgVQXAQmHSHc+HmK553z+LkU2Yjz+fwAAAAZ2HgAL5BfgfAcYnsX2zf/xDBdA4ABAABQEIPhACYxwgCc5uB4iXOB0Zbk3/4+C6DgAEQAEU8LuCUn4HRlueB4iXEeTN/+AcFUK2glJw8hXPDpjueb/AMPBVF0WrDpjufDyFc6PJnW4AAAAASYeAA/kCe+rfVqP8DD4GHR5J4AAAATG1mcmEAAAA0dGZyYQEAAAAAAAABAAAAPwAAAAEAAAAAAAAAAAAAAAAAAALuAAAAAQAAAAEAAAABAAAAEG1mcm8BAAAAAAAATA==';

function quoteCapacity(): number {
  if (process.env.NODE_ENV !== 'test') return MAX_QUOTES;
  const configured = Number(process.env.USER_WEB_COMMERCE_MOCK_QUOTE_CAPACITY);
  return Number.isSafeInteger(configured) && configured >= 1 && configured <= MAX_QUOTES
    ? configured
    : MAX_QUOTES;
}

interface StoredQuote {
  readonly quote: StudioQuote;
  readonly request: StudioQuoteRequest;
}

interface StoredTask {
  readonly detail: TaskDetail;
  readonly failureSimulation: boolean;
  readonly resultAssetId: string;
}

interface Submission {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly taskId: string;
}

interface Cancellation {
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly taskId: string;
  readonly snapshot: TaskDetail['statusSnapshot'];
}

interface CommercialState {
  readonly version: 2;
  readonly quotes: readonly StoredQuote[];
  readonly tasks: readonly StoredTask[];
  readonly submissions: readonly Submission[];
  readonly cancellations: readonly Cancellation[];
}

export class MockCommercialError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;
}

function requireMock(ownerId: string): void {
  if (process.env.USER_WEB_STUDIO_MODE !== 'mock') throw new Error('STUDIO_GATEWAY_UNAVAILABLE');
  if (!UuidSchema.safeParse(ownerId).success) throw new MockCommercialError('INVALID_OWNER');
}

function blankState(): CommercialState {
  return { version: 2, quotes: [], tasks: [], submissions: [], cancellations: [] };
}

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new MockCommercialError(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new MockCommercialError(code);
  }
}

function parseCommercial(value: unknown): CommercialState {
  if (value === undefined) return blankState();
  const state = record(value, 'INVALID_COMMERCIAL_STATE');
  const stateKeys =
    state.version === 1
      ? ['version', 'quotes', 'tasks', 'submissions']
      : ['version', 'quotes', 'tasks', 'submissions', 'cancellations'];
  exact(state, stateKeys, 'INVALID_COMMERCIAL_STATE');
  if (
    (state.version !== 1 && state.version !== 2) ||
    !Array.isArray(state.quotes) ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.submissions) ||
    (state.version === 2 && !Array.isArray(state.cancellations))
  ) {
    throw new MockCommercialError('INVALID_COMMERCIAL_STATE');
  }
  const quotes = state.quotes.map((value) => {
    const item = record(value, 'INVALID_COMMERCIAL_QUOTE');
    exact(item, ['quote', 'request'], 'INVALID_COMMERCIAL_QUOTE');
    return item as unknown as StoredQuote;
  });
  const tasks = state.tasks.map((value) => {
    const item = record(value, 'INVALID_COMMERCIAL_TASK');
    exact(item, ['detail', 'failureSimulation', 'resultAssetId'], 'INVALID_COMMERCIAL_TASK');
    if (typeof item.failureSimulation !== 'boolean' || !isUuidV7(item.resultAssetId)) {
      throw new MockCommercialError('INVALID_COMMERCIAL_TASK');
    }
    return item as unknown as StoredTask;
  });
  const submissions = state.submissions.map((value) => {
    const item = record(value, 'INVALID_COMMERCIAL_SUBMISSION');
    exact(item, ['idempotencyKey', 'fingerprint', 'taskId'], 'INVALID_COMMERCIAL_SUBMISSION');
    if (
      !isUuidV7(item.idempotencyKey) ||
      typeof item.fingerprint !== 'string' ||
      !isUuidV7(item.taskId)
    ) {
      throw new MockCommercialError('INVALID_COMMERCIAL_SUBMISSION');
    }
    return item as unknown as Submission;
  });
  const cancellationValues: readonly unknown[] =
    state.version === 2 && Array.isArray(state.cancellations) ? state.cancellations : [];
  const cancellations: readonly Cancellation[] = cancellationValues.map((value) => {
    const item = record(value, 'INVALID_COMMERCIAL_CANCELLATION');
    exact(
      item,
      ['idempotencyKey', 'fingerprint', 'taskId', 'snapshot'],
      'INVALID_COMMERCIAL_CANCELLATION',
    );
    if (
      !isUuidV7(item.idempotencyKey) ||
      typeof item.fingerprint !== 'string' ||
      !isUuidV7(item.taskId)
    ) {
      throw new MockCommercialError('INVALID_COMMERCIAL_CANCELLATION');
    }
    return item as unknown as Cancellation;
  });
  if (
    new Set(quotes.map(({ quote }) => quote.id)).size !== quotes.length ||
    new Set(tasks.map(({ detail }) => detail.id)).size !== tasks.length ||
    new Set(submissions.map(({ idempotencyKey }) => idempotencyKey)).size !== submissions.length ||
    new Set(cancellations.map(({ idempotencyKey }) => idempotencyKey)).size !== cancellations.length
  ) {
    throw new MockCommercialError('INVALID_COMMERCIAL_STATE');
  }
  return { version: 2, quotes, tasks, submissions, cancellations };
}

function writeCommercial(finance: MutableMockFinanceState, state: CommercialState): void {
  finance.commercial = structuredClone(state);
}

function taskLabel(taskNumber: string): string {
  return `生成任务 ${taskNumber}`;
}

function transaction(
  type: 'RESERVE' | 'SETTLE' | 'RELEASE',
  task: TaskDetail,
  now: string,
): LedgerTransaction {
  return {
    id: createUuidV7(Date.parse(now)),
    type,
    direction: type === 'SETTLE' ? 'DEBIT' : 'TRANSFER',
    status: 'POSTED',
    points: task.quotedPoints,
    occurredAt: now,
    reference: { kind: 'TASK', id: task.id, label: taskLabel(task.taskNumber) },
  };
}

function statusLabel(status: TaskStatus): string {
  const labels: Readonly<Record<TaskStatus, string>> = {
    QUOTED: '报价已确认',
    RESERVED: '点数已冻结',
    QUEUED: '任务已进入队列',
    SUBMITTING: '正在提交生成服务',
    RUNNING: '生成服务正在处理',
    SUCCEEDED: '生成结果已返回',
    FAILED: '生成未完成，等待退款',
    CANCELED: '取消请求已接受',
    EXPIRED: '任务已过期',
    SETTLED: '任务已结算',
    REFUNDED: '冻结点数已退回',
  };
  return labels[status];
}

function nextStatus(task: StoredTask): TaskStatus | undefined {
  switch (task.detail.statusSnapshot.status) {
    case 'QUEUED':
      return 'SUBMITTING';
    case 'SUBMITTING':
      return 'RUNNING';
    case 'RUNNING':
      return task.failureSimulation ? 'FAILED' : 'SUCCEEDED';
    case 'SUCCEEDED':
      return 'SETTLED';
    case 'FAILED':
      return 'REFUNDED';
    default:
      return undefined;
  }
}

function updateMoney(
  finance: MutableMockFinanceState,
  task: TaskDetail,
  status: TaskStatus,
  now: string,
) {
  const points = BigInt(task.quotedPoints);
  if (status === 'SETTLED') {
    finance.balance = {
      ...finance.balance,
      frozen: (BigInt(finance.balance.frozen) - points).toString(),
      totalConsumed: (BigInt(finance.balance.totalConsumed) + points).toString(),
    };
    finance.ledger.unshift(transaction('SETTLE', task, now));
  }
  if (status === 'REFUNDED') {
    finance.balance = {
      ...finance.balance,
      available: (BigInt(finance.balance.available) + points).toString(),
      frozen: (BigInt(finance.balance.frozen) - points).toString(),
    };
    finance.ledger.unshift(transaction('RELEASE', task, now));
  }
}

function publicTask(stored: StoredTask): TaskDetail {
  const detail = structuredClone(stored.detail);
  return detail.statusSnapshot.status === 'SETTLED'
    ? { ...detail, result: { assetId: stored.resultAssetId } }
    : detail;
}

export async function saveMockCommercialQuote(
  ownerId: string,
  request: StudioQuoteRequest,
  quote: StudioQuote,
): Promise<StudioQuote> {
  requireMock(ownerId);
  return runMockFinanceTransaction(
    ownerId,
    () => createMockFinanceSeed(ownerId),
    (finance) => {
      const state = parseCommercial(finance.commercial);
      const activeQuotes = state.quotes.filter(
        ({ quote: storedQuote }) => Date.parse(storedQuote.expiresAt) > Date.now(),
      );
      if (activeQuotes.length >= quoteCapacity()) throw new MockCommercialError('QUOTE_CAPACITY');
      writeCommercial(finance, {
        ...state,
        quotes: [
          ...activeQuotes,
          { request: structuredClone(request), quote: structuredClone(quote) },
        ],
      });
      return structuredClone(quote);
    },
  );
}

export async function createMockCommercialTask(
  ownerId: string,
  request: StudioCreateTaskRequest,
  idempotencyKey: string,
): Promise<StudioTaskAccepted> {
  requireMock(ownerId);
  if (!isUuidV7(idempotencyKey)) throw new MockCommercialError('INVALID_IDEMPOTENCY_KEY');
  const fingerprint = createHash('sha256').update(JSON.stringify(request)).digest('hex');
  return runMockFinanceTransaction(
    ownerId,
    () => createMockFinanceSeed(ownerId),
    (finance) => {
      const state = parseCommercial(finance.commercial);
      const replay = state.submissions.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint)
          throw new MockCommercialError('IDEMPOTENCY_CONFLICT');
        return { taskId: replay.taskId, status: 'QUEUED' };
      }
      const storedQuote = state.quotes.find(({ quote }) => quote.id === request.quoteId);
      if (!storedQuote || Date.parse(storedQuote.quote.expiresAt) <= Date.now()) {
        throw new MockCommercialError('QUOTE_EXPIRED');
      }
      const quote = storedQuote.quote;
      if (
        quote.capabilityVersion !== request.capabilityVersion ||
        quote.quotedPoints !== request.quotedPoints ||
        !stableDeepEqual(quote.parameters, request.parameters)
      ) {
        throw new MockCommercialError('QUOTE_SNAPSHOT_MISMATCH');
      }
      if (state.tasks.length >= MAX_TASKS) throw new MockCommercialError('TASK_CAPACITY');
      const points = BigInt(quote.quotedPoints);
      if (BigInt(finance.balance.available) < points)
        throw new MockCommercialError('INSUFFICIENT_POINTS');
      const now = new Date().toISOString();
      const taskId = createUuidV7();
      const taskNumber = `T${now.slice(0, 10).replaceAll('-', '')}-${taskId.slice(-4).toUpperCase()}`;
      const routing = storedQuote.request.routing;
      if (routing.kind === 'EXACT_MODEL' && quote.routing.kind !== 'EXACT_MODEL') {
        throw new MockCommercialError('QUOTE_ROUTING_MISMATCH');
      }
      const generationMode =
        routing.kind === 'SMART'
          ? routing.preferences.generationMode
          : routing.modelId === 'mock-story-v3'
            ? 'TEXT_TO_VIDEO'
            : 'IMAGE_TO_VIDEO';
      const modelId = routing.kind === 'EXACT_MODEL' ? routing.modelId : 'mock-story-v3';
      const modelName =
        routing.kind === 'EXACT_MODEL' && quote.routing.kind === 'EXACT_MODEL'
          ? quote.routing.modelName
          : 'Story V3';
      const eastProvider = modelId === 'mock-cinema-v2';
      const queuedSnapshot = {
        eventId: `1:${createUuidV7()}`,
        revision: 1,
        status: 'QUEUED',
        terminal: false,
        cancelAllowed: true,
        updatedAt: now,
      } as const;
      const timeline: TaskTimelineItem[] = [{ ...queuedSnapshot, label: statusLabel('QUEUED') }];
      const detail: TaskDetail = {
        id: taskId,
        taskNumber,
        generationMode,
        modelName,
        providerName: eastProvider ? '演示平台 East' : '演示平台 West',
        createdAt: now,
        quotedPoints: quote.quotedPoints,
        statusSnapshot: queuedSnapshot,
        modelSnapshot: {
          modelId,
          modelName,
          providerId: eastProvider ? 'mock-provider-east' : 'mock-provider-west',
          providerName: eastProvider ? '演示平台 East' : '演示平台 West',
          capabilityVersion: quote.capabilityVersion,
          pricingVersion: 'mock-pricing-v1',
        },
        parametersSnapshot: structuredClone(quote.parameters),
        parameterSummary: quote.parameterSummary.map(({ key, label, value, unit }) => ({
          key,
          label,
          value: unit ? `${value} ${unit}` : value,
        })),
        financial: {
          availablePoints: (BigInt(finance.balance.available) - points).toString(),
          frozenPoints: points.toString(),
          settledPoints: '0',
          refundedPoints: '0',
        },
        timeline,
      };
      finance.balance = {
        ...finance.balance,
        available: detail.financial.availablePoints,
        frozen: (BigInt(finance.balance.frozen) + points).toString(),
      };
      finance.ledger.unshift(transaction('RESERVE', detail, now));
      writeCommercial(finance, {
        ...state,
        tasks: [
          ...state.tasks,
          {
            detail,
            failureSimulation: quote.parameters.mockFailure === true,
            resultAssetId: createUuidV7(),
          },
        ],
        submissions: [...state.submissions, { idempotencyKey, fingerprint, taskId }],
      });
      return { taskId, status: 'QUEUED' };
    },
  );
}

export async function listMockCommercialTasks(ownerId: string): Promise<readonly TaskDetail[]> {
  requireMock(ownerId);
  return runMockFinanceTransaction(
    ownerId,
    () => createMockFinanceSeed(ownerId),
    (finance) => parseCommercial(finance.commercial).tasks.map(publicTask),
  );
}

function advanceStoredTask(
  finance: MutableMockFinanceState,
  state: CommercialState,
  index: number,
  current: StoredTask,
): StoredTask {
  const status = nextStatus(current);
  if (!status) return current;
  const now = new Date().toISOString();
  const revision = current.detail.statusSnapshot.revision + 1;
  const snapshot = {
    eventId: `${String(revision)}:${createUuidV7()}`,
    revision,
    status,
    terminal: status === 'SETTLED' || status === 'REFUNDED',
    cancelAllowed: status === 'SUBMITTING' || status === 'RUNNING',
    updatedAt: now,
    ...(status === 'FAILED'
      ? {
          publicReason: {
            code: 'MOCK_GENERATION_FAILED',
            message: '模拟生成未完成，冻结点数正在退回。',
          },
        }
      : {}),
  } as const;
  const timeline = [...current.detail.timeline, { ...snapshot, label: statusLabel(status) }];
  const points = current.detail.quotedPoints;
  const financial =
    status === 'SETTLED'
      ? {
          availablePoints: finance.balance.available,
          frozenPoints: '0',
          settledPoints: points,
          refundedPoints: '0',
        }
      : status === 'REFUNDED'
        ? {
            availablePoints: (BigInt(finance.balance.available) + BigInt(points)).toString(),
            frozenPoints: '0',
            settledPoints: '0',
            refundedPoints: points,
          }
        : current.detail.financial;
  updateMoney(finance, current.detail, status, now);
  const next: StoredTask = {
    ...current,
    detail: { ...current.detail, statusSnapshot: snapshot, timeline, financial },
  };
  const tasks = [...state.tasks];
  tasks[index] = next;
  writeCommercial(finance, { ...state, tasks });
  return next;
}

async function ensureResultObject(ownerId: string, stored: StoredTask): Promise<void> {
  if (stored.detail.statusSnapshot.status !== 'SETTLED') return;
  await ensureMockSeedObjects(ownerId, [
    {
      assetId: stored.resultAssetId,
      kind: 'RESULT',
      name: `${stored.detail.taskNumber}-result.mp4`,
      mimeType: 'video/mp4',
      createdAt: stored.detail.statusSnapshot.updatedAt,
      bytes: new Uint8Array(Buffer.from(MOCK_RESULT_MP4_BASE64, 'base64')),
    },
  ]);
}

export async function readMockCommercialTask(
  ownerId: string,
  taskId: string,
): Promise<TaskDetail | undefined> {
  requireMock(ownerId);
  const stored = await runMockFinanceTransaction(
    ownerId,
    () => createMockFinanceSeed(ownerId),
    (finance) => {
      const state = parseCommercial(finance.commercial);
      return state.tasks.find(({ detail }) => detail.id === taskId);
    },
  );
  if (!stored) return undefined;
  await ensureResultObject(ownerId, stored);
  return publicTask(stored);
}

export async function readOrAdvanceMockCommercialTaskEvent(
  ownerId: string,
  taskId: string,
  lastEventId?: string,
): Promise<TaskDetail['statusSnapshot'] | undefined> {
  requireMock(ownerId);
  const result = await runMockFinanceTransaction(
    ownerId,
    () => createMockFinanceSeed(ownerId),
    (finance) => {
      const state = parseCommercial(finance.commercial);
      const index = state.tasks.findIndex(({ detail }) => detail.id === taskId);
      if (index < 0) return undefined;
      const current = state.tasks[index];
      if (!current) return undefined;
      if (lastEventId) {
        const cursorIndex = current.detail.timeline.findIndex(
          ({ eventId }) => eventId === lastEventId,
        );
        if (cursorIndex < 0) throw new MockCommercialError('INVALID_TASK_CURSOR');
        const nextExisting = current.detail.timeline[cursorIndex + 1];
        if (nextExisting) {
          const { label: _label, ...snapshot } = nextExisting;
          void _label;
          return { stored: current, snapshot };
        }
      }
      const advanced = advanceStoredTask(finance, state, index, current);
      return { stored: advanced, snapshot: advanced.detail.statusSnapshot };
    },
  );
  if (!result) return undefined;
  await ensureResultObject(ownerId, result.stored);
  return structuredClone(result.snapshot);
}

export async function cancelMockCommercialTask(
  ownerId: string,
  taskId: string,
  idempotencyKey: string,
): Promise<TaskDetail['statusSnapshot']> {
  requireMock(ownerId);
  if (!isUuidV7(idempotencyKey)) throw new MockCommercialError('INVALID_IDEMPOTENCY_KEY');
  const fingerprint = createHash('sha256').update(`cancel:${taskId}`).digest('hex');
  return runMockFinanceTransaction(
    ownerId,
    () => createMockFinanceSeed(ownerId),
    (finance) => {
      const state = parseCommercial(finance.commercial);
      const replay = state.cancellations.find((entry) => entry.idempotencyKey === idempotencyKey);
      if (replay) {
        if (replay.fingerprint !== fingerprint || replay.taskId !== taskId) {
          throw new MockCommercialError('IDEMPOTENCY_CONFLICT');
        }
        return structuredClone(replay.snapshot);
      }
      const index = state.tasks.findIndex(({ detail }) => detail.id === taskId);
      const current = index >= 0 ? state.tasks[index] : undefined;
      if (!current) throw new MockCommercialError('TASK_NOT_FOUND');
      if (!current.detail.statusSnapshot.cancelAllowed) {
        throw new MockCommercialError('CANCEL_NOT_ALLOWED');
      }
      const now = new Date().toISOString();
      const canceledRevision = current.detail.statusSnapshot.revision + 1;
      const canceled = {
        eventId: `${String(canceledRevision)}:${createUuidV7()}`,
        revision: canceledRevision,
        status: 'CANCELED',
        terminal: false,
        cancelAllowed: false,
        updatedAt: now,
        publicReason: { code: 'USER_CANCELED', message: '取消请求已接受，冻结点数已退回。' },
      } as const;
      const refunded = {
        ...canceled,
        eventId: `${String(canceledRevision + 1)}:${createUuidV7()}`,
        revision: canceledRevision + 1,
        status: 'REFUNDED',
        terminal: true,
      } as const;
      const points = BigInt(current.detail.quotedPoints);
      finance.balance = {
        ...finance.balance,
        available: (BigInt(finance.balance.available) + points).toString(),
        frozen: (BigInt(finance.balance.frozen) - points).toString(),
      };
      finance.ledger.unshift(transaction('RELEASE', current.detail, now));
      const next: StoredTask = {
        ...current,
        detail: {
          ...current.detail,
          statusSnapshot: refunded,
          financial: {
            availablePoints: finance.balance.available,
            frozenPoints: '0',
            settledPoints: '0',
            refundedPoints: points.toString(),
          },
          timeline: [
            ...current.detail.timeline,
            { ...canceled, label: statusLabel('CANCELED') },
            { ...refunded, label: statusLabel('REFUNDED') },
          ],
        },
      };
      const tasks = [...state.tasks];
      tasks[index] = next;
      writeCommercial(finance, {
        ...state,
        tasks,
        cancellations: [
          ...state.cancellations,
          { idempotencyKey, fingerprint, taskId, snapshot: refunded },
        ],
      });
      return structuredClone(refunded);
    },
  );
}
