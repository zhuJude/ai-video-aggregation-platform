import { createHash } from 'node:crypto';
import type { CanonicalCreateTask, ProviderResult, ProviderState } from '@repo/provider-sdk';

export const MOCK_SCENARIOS = [
  'success',
  'failed',
  'timeout',
  'rate-limit',
  'server-error',
  'callback-lost',
  'callback-duplicate',
  'callback-out-of-order',
] as const;

export type MockScenario = (typeof MOCK_SCENARIOS)[number];

export type MockCreateInput = Omit<CanonicalCreateTask, 'idempotencyKey'>;

export interface MockTaskResponse extends ProviderResult {
  providerTaskId: string;
  scenario: MockScenario;
}

export interface MockCreateResponse extends MockTaskResponse {
  state: 'ACCEPTED';
}

export interface MockCancelResponse extends MockTaskResponse {
  state: 'CANCELED';
  canceled: true;
}

export interface MockBalance {
  unit: 'MOCK_CREDITS';
  available: '1000000';
  nonReal: true;
}

export interface MockCallbackBody {
  eventId: string;
  providerTaskId: string;
  sequence: number;
  state: ProviderState;
  occurredAt: string;
  resultUrls?: string[];
  errorCode?: string;
  errorMessage?: string;
}

export interface CallbackDelivery {
  headers: Readonly<Record<string, string>>;
  body: MockCallbackBody;
  rawBody: Buffer;
}

export class MockProviderHttpError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    code: string;
    message: string;
    status: number;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = 'MockProviderHttpError';
    this.code = input.code;
    this.status = input.status;
    if (input.retryAfterSeconds !== undefined) {
      this.retryAfterSeconds = input.retryAfterSeconds;
    }
  }
}

export function isMockScenario(value: unknown): value is MockScenario {
  return typeof value === 'string' && (MOCK_SCENARIOS as readonly string[]).includes(value);
}

export function isCreateInput(value: unknown): value is MockCreateInput {
  if (!isPlainObject(value)) return false;
  if (!hasOnlyKeys(value, ['taskId', 'modelCode', 'parameters'])) return false;
  return (
    isNonEmptyString(value.taskId, 256) &&
    isNonEmptyString(value.modelCode, 128) &&
    isPlainObject(value.parameters)
  );
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

export function requestFingerprint(input: MockCreateInput, scenario: MockScenario): string {
  return createHash('sha256').update(canonicalJson({ input, scenario })).digest('hex');
}

export function deterministicTaskId(idempotencyKey: string, fingerprint: string): string {
  const digest = createHash('sha256')
    .update(`mock-task:${idempotencyKey}:${fingerprint}`)
    .digest('hex');
  return `mock_${digest.slice(0, 24)}`;
}

export function deterministicEventId(providerTaskId: string, sequence: number): string {
  const digest = createHash('sha256')
    .update(`mock-event:${providerTaskId}:${String(sequence)}`)
    .digest('hex');
  return `evt_${digest.slice(0, 24)}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  return Object.keys(value).every((key) => allowedKeys.has(key));
}

function isNonEmptyString(value: unknown, maximumLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximumLength;
}
