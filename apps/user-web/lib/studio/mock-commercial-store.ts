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

interface CommercialState {
  readonly version: 1;
  readonly quotes: readonly StoredQuote[];
  readonly tasks: readonly StoredTask[];
  readonly submissions: readonly Submission[];
}

export class MockCommercialError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;
}

function requireMock(ownerId: string): void {
  if (process.env.USER_WEB_STUDIO_MODE !== 'mock') throw new Error('STUDIO_GATEWAY_UNAVAILABLE');
  if (!UuidSchema.safeParse(ownerId).success) throw new MockCommercialError('INVALID_OWNER');
}

function blankState(): CommercialState {
  return { version: 1, quotes: [], tasks: [], submissions: [] };
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
  exact(state, ['version', 'quotes', 'tasks', 'submissions'], 'INVALID_COMMERCIAL_STATE');
  if (
    state.version !== 1 ||
    !Array.isArray(state.quotes) ||
    !Array.isArray(state.tasks) ||
    !Array.isArray(state.submissions)
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
  if (
    new Set(quotes.map(({ quote }) => quote.id)).size !== quotes.length ||
    new Set(tasks.map(({ detail }) => detail.id)).size !== tasks.length ||
    new Set(submissions.map(({ idempotencyKey }) => idempotencyKey)).size !== submissions.length
  ) {
    throw new MockCommercialError('INVALID_COMMERCIAL_STATE');
  }
  return { version: 1, quotes, tasks, submissions };
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
      if (state.quotes.length >= MAX_QUOTES) throw new MockCommercialError('QUOTE_CAPACITY');
      writeCommercial(finance, {
        ...state,
        quotes: [
          ...state.quotes,
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

export async function readAndAdvanceMockCommercialTask(
  ownerId: string,
  taskId: string,
): Promise<TaskDetail | undefined> {
  requireMock(ownerId);
  const stored = await runMockFinanceTransaction(
    ownerId,
    () => createMockFinanceSeed(ownerId),
    (finance) => {
      const state = parseCommercial(finance.commercial);
      const index = state.tasks.findIndex(({ detail }) => detail.id === taskId);
      if (index < 0) return undefined;
      const current = state.tasks[index];
      if (!current) return undefined;
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
    },
  );
  if (!stored) return undefined;
  if (stored.detail.statusSnapshot.status === 'SETTLED') {
    await ensureMockSeedObjects(ownerId, [
      {
        assetId: stored.resultAssetId,
        kind: 'RESULT',
        name: `${stored.detail.taskNumber}-result.mp4`,
        mimeType: 'video/mp4',
        createdAt: stored.detail.statusSnapshot.updatedAt,
        bytes: new Uint8Array([
          0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
        ]),
      },
    ]);
  }
  return publicTask(stored);
}
