import { types as utilTypes } from 'node:util';

import {
  createOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';
import {
  isPoints,
  redactRawPayload,
  type RoutingSimulation,
  type TaskDetail,
  type TaskOperation,
} from './operations-control';
import { type DataScope, hasPermission } from './permissions';
import {
  assertAdminDataScope,
  requireAdminAnyAuthorization,
  requireAdminAuthorization,
  type ServerGuardContext,
} from './server-guard';
import { isUuidV7 } from './uuid-v7';
import { isUtcIso8601Z } from './frozen-scalars';

export type VersionSummary = Readonly<{
  effectiveAt: string;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  version: number;
  versionId: string;
}>;
export type PricingView = Readonly<{
  costPoints: string;
  effectiveAt: string;
  minimumMarginBps: number;
  rules: readonly Readonly<{
    costPoints: string;
    durationSeconds: number;
    id: string;
    markupBps: number;
    modelCode: string;
    parameterKey: string;
    resolution: string;
    salePoints: string;
    strategy: 'FIXED' | 'MARKUP' | 'TIERED';
    tiersJson: string;
  }>[];
  salePoints: string;
  sourceUpdatedAt: string;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  version: number;
  versionId: string;
  versions: readonly VersionSummary[];
}>;
export type RoutingPolicyView = Readonly<{
  backupCapabilityMapJson: string;
  effectiveAt: string;
  failoverMode: 'DISABLED' | 'SMART_ONLY' | 'USER_OPT_IN';
  minimumMarginBps: number;
  priceWeight: number;
  providerPriorityJson: string;
  publishPreflight: Readonly<{
    diff: string;
    expiresAt: string;
    impact: string;
    previewToken: string;
    version: number;
    versionId: string;
  }> | null;
  qualityWeight: number;
  sourceUpdatedAt: string;
  speedWeight: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  version: number;
  versionId: string;
  versions: readonly VersionSummary[];
}>;
export type TaskSummary = Readonly<{
  id: string;
  providerName: string;
  status: string;
  updatedAt: string;
  userIdMasked: string;
}>;
export type TaskDirectory = Readonly<{
  items: readonly TaskSummary[];
  nextCursor: string | null;
  partialFields: readonly string[];
  queue: Readonly<{
    backlog: number;
    concurrencyLimit: number;
    defaultPriority: number;
    operationPreviews: readonly Readonly<{
      action: 'PAUSE' | 'RESUME' | 'UPDATE_LIMITS';
      expiresAt: string;
      impact: string;
      preflightToken: string;
      version: number;
    }>[];
    paused: boolean;
    rateLimitPerMinute: number;
    running: number;
    version: number;
  }>;
  sourceUpdatedAt: string;
}>;
type BaseRequest = Readonly<{
  requestContext: OutboundRequestContext;
  scope: DataScope;
  trustedSessionToken: string;
}>;

export interface PricingOperationsPort {
  getPricing(input: BaseRequest): Promise<unknown>;
  save(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        effectiveAt: string;
        expectedVersion: number;
        markupBps: number;
        ruleId: string;
        salePoints: string;
        strategy: 'FIXED' | 'MARKUP' | 'TIERED';
        tiers: unknown;
        versionId: string;
      }>,
  ): Promise<unknown>;
  preview(
    input: BaseRequest &
      Readonly<{
        effectiveAt: string;
        expectedVersion: number;
        markupBps: number;
        ruleId: string;
        salePoints: string;
        strategy: 'FIXED' | 'MARKUP' | 'TIERED';
        tiers: unknown;
        versionId: string;
      }>,
  ): Promise<unknown>;
  publish(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        confirmed: true;
        expectedVersion: number;
        previewToken: string;
        versionId: string;
      }>,
  ): Promise<unknown>;
  rollback(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        confirmed: true;
        expectedVersion: number;
        targetVersionId: string;
        versionId: string;
      }>,
  ): Promise<unknown>;
}
export interface RoutingOperationsPort {
  getRouting(input: BaseRequest): Promise<unknown>;
  preview(
    input: BaseRequest & Readonly<{ expectedVersion: number; versionId: string }>,
  ): Promise<unknown>;
  save(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        backupCapabilityMap: unknown;
        effectiveAt: string;
        expectedVersion: number;
        failoverMode: string;
        minimumMarginBps: number;
        priceWeight: number;
        providerPriority: unknown;
        qualityWeight: number;
        speedWeight: number;
        versionId: string;
      }>,
  ): Promise<unknown>;
  publish(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        confirmed: true;
        expectedVersion: number;
        previewToken: string;
        versionId: string;
      }>,
  ): Promise<unknown>;
  rollback(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        confirmed: true;
        expectedVersion: number;
        targetVersionId: string;
        versionId: string;
      }>,
  ): Promise<unknown>;
  simulate(
    input: BaseRequest & Readonly<{ parameters: Readonly<Record<string, unknown>> }>,
  ): Promise<unknown>;
}
export interface TaskOperationsPort {
  listTasks?(
    input: BaseRequest & Readonly<{ cursor: string; query: string; status: string }>,
  ): Promise<unknown>;
  getTask(input: BaseRequest & Readonly<{ taskId: string }>): Promise<unknown>;
  getRaw?(input: BaseRequest & Readonly<{ taskId: string }>): Promise<unknown>;
  execute?(
    input: BaseRequest &
      Readonly<{
        action: TaskOperation;
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        confirmed: true;
        expectedVersion: number;
        impactToken: string;
        taskId: string;
      }>,
  ): Promise<unknown>;
  executeQueue?(
    input: BaseRequest &
      Readonly<{
        actorId: string;
        audit: Readonly<{ idempotencyKey: string; reason: string }>;
        confirmed: true;
        expectedPaused: boolean;
        expectedVersion: number;
        impactToken: string;
      }> &
      (
        | Readonly<{ action: 'PAUSE' | 'RESUME' }>
        | Readonly<{
            action: 'UPDATE_LIMITS';
            concurrencyLimit: number;
            defaultPriority: number;
            rateLimitPerMinute: number;
          }>
      ),
  ): Promise<unknown>;
}

function plainRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || utilTypes.isProxy(value))
    throw new Error('运营服务响应无效');
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) throw new Error('运营服务响应无效');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !descriptor?.enumerable || !('value' in descriptor))
      throw new Error('运营服务响应无效');
  }
  return value as Readonly<Record<string, unknown>>;
}
function exact(value: unknown, keys: readonly string[]) {
  const record = plainRecord(value);
  const own = Object.keys(record);
  if (own.length !== keys.length || keys.some((key) => !own.includes(key)))
    throw new Error('运营服务响应无效');
  return record;
}
function safeText(value: unknown, max = 300): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{C}]/u.test(value)
  );
}
function safeVersion(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}
function stringArray(value: unknown, max = 100): readonly string[] {
  if (!Array.isArray(value) || value.length > max || value.some((item) => !safeText(item)))
    throw new Error('运营服务响应无效');
  const values: readonly unknown[] = value;
  return Object.freeze(values.map((item) => item as string));
}

const ROUTING_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
function routingIdentifierArray(value: unknown, allowEmpty: boolean): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    (!allowEmpty && value.length === 0) ||
    value.some((item) => typeof item !== 'string' || !ROUTING_IDENTIFIER.test(item)) ||
    new Set(value).size !== value.length
  )
    throw new Error('路由策略响应无效');
  return Object.freeze(value.map((item) => item as string));
}
function parseProviderPriority(value: unknown): readonly string[] {
  return routingIdentifierArray(value, false);
}
function parseBackupCapabilityMap(value: unknown): Readonly<Record<string, readonly string[]>> {
  const record = plainRecord(value);
  const entries = Object.entries(record);
  if (entries.length > 100) throw new Error('路由策略响应无效');
  const parsed: Record<string, readonly string[]> = {};
  for (const [capability, providers] of entries) {
    if (!ROUTING_IDENTIFIER.test(capability)) throw new Error('路由策略响应无效');
    parsed[capability] = routingIdentifierArray(providers, false);
  }
  return Object.freeze(parsed);
}

function parsePricingTiers(
  tiersJson: string,
  strategy: 'FIXED' | 'MARKUP' | 'TIERED',
): readonly Readonly<{ minimumUnits: number; salePoints: string }>[] {
  try {
    const value: unknown = JSON.parse(tiersJson);
    if (
      !Array.isArray(value) ||
      value.length > 100 ||
      (strategy === 'TIERED' && value.length === 0)
    )
      throw new Error('invalid');
    if (strategy !== 'TIERED' && value.length !== 0) throw new Error('invalid');
    let previousMinimum = 0;
    const tiers = value.map((item) => {
      const tier = exact(item, ['minimumUnits', 'salePoints']);
      if (
        typeof tier.minimumUnits !== 'number' ||
        !Number.isSafeInteger(tier.minimumUnits) ||
        tier.minimumUnits < 1 ||
        tier.minimumUnits > 1_000_000_000 ||
        tier.minimumUnits <= previousMinimum ||
        !isPoints(tier.salePoints)
      )
        throw new Error('invalid');
      previousMinimum = tier.minimumUnits;
      return Object.freeze({ minimumUnits: tier.minimumUnits, salePoints: tier.salePoints });
    });
    return Object.freeze(tiers);
  } catch {
    throw new Error('定价阶梯规则无效');
  }
}

function parseVersions(value: unknown): readonly VersionSummary[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('配置版本响应无效');
  return Object.freeze(
    value.map((item) => {
      const version = exact(item, ['effectiveAt', 'status', 'version', 'versionId']);
      if (
        !isUuidV7(version.versionId) ||
        !safeVersion(version.version) ||
        !safeText(version.effectiveAt) ||
        (version.status !== 'DRAFT' &&
          version.status !== 'PUBLISHED' &&
          version.status !== 'RETIRED')
      )
        throw new Error('配置版本响应无效');
      return Object.freeze(version) as VersionSummary;
    }),
  );
}
export function parsePricingView(value: unknown): PricingView {
  const row = exact(value, [
    'costPoints',
    'effectiveAt',
    'minimumMarginBps',
    'rules',
    'salePoints',
    'sourceUpdatedAt',
    'status',
    'version',
    'versionId',
    'versions',
  ]);
  if (
    !isPoints(row.costPoints as string) ||
    !isPoints(row.salePoints as string) ||
    typeof row.minimumMarginBps !== 'number' ||
    !Number.isSafeInteger(row.minimumMarginBps) ||
    row.minimumMarginBps < 0 ||
    row.minimumMarginBps > 10_000 ||
    !isUtcIso8601Z(row.effectiveAt as string) ||
    !isUtcIso8601Z(row.sourceUpdatedAt as string) ||
    !safeVersion(row.version) ||
    !isUuidV7(row.versionId) ||
    (row.status !== 'DRAFT' && row.status !== 'PUBLISHED' && row.status !== 'RETIRED')
  )
    throw new Error('定价响应无效');
  if (!Array.isArray(row.rules) || row.rules.length > 500) throw new Error('定价响应无效');
  const rules = row.rules.map((value) => {
    const rule = exact(value, [
      'costPoints',
      'durationSeconds',
      'id',
      'markupBps',
      'modelCode',
      'parameterKey',
      'resolution',
      'salePoints',
      'strategy',
      'tiersJson',
    ]);
    if (
      !safeText(rule.id) ||
      !safeText(rule.modelCode) ||
      !safeText(rule.parameterKey) ||
      !safeText(rule.resolution) ||
      !isPoints(rule.costPoints) ||
      !isPoints(rule.salePoints) ||
      typeof rule.durationSeconds !== 'number' ||
      !Number.isSafeInteger(rule.durationSeconds) ||
      rule.durationSeconds < 1 ||
      typeof rule.markupBps !== 'number' ||
      !Number.isSafeInteger(rule.markupBps) ||
      rule.markupBps < 0 ||
      rule.markupBps > 100_000 ||
      !['FIXED', 'MARKUP', 'TIERED'].includes(rule.strategy as string) ||
      typeof rule.tiersJson !== 'string' ||
      rule.tiersJson.length > 20_000
    )
      throw new Error('定价响应无效');
    parsePricingTiers(rule.tiersJson, rule.strategy as 'FIXED' | 'MARKUP' | 'TIERED');
    return Object.freeze(rule);
  });
  return Object.freeze({
    ...row,
    rules: Object.freeze(rules),
    versions: parseVersions(row.versions),
  }) as PricingView;
}

export function parseRoutingPolicyView(value: unknown): RoutingPolicyView {
  const row = exact(value, [
    'backupCapabilityMapJson',
    'effectiveAt',
    'failoverMode',
    'minimumMarginBps',
    'priceWeight',
    'providerPriorityJson',
    'publishPreflight',
    'qualityWeight',
    'sourceUpdatedAt',
    'speedWeight',
    'status',
    'version',
    'versionId',
    'versions',
  ]);
  const weights = [row.qualityWeight, row.speedWeight, row.priceWeight];
  if (
    weights.some(
      (weight) =>
        typeof weight !== 'number' || !Number.isSafeInteger(weight) || weight < 0 || weight > 100,
    ) ||
    weights.reduce<number>((sum, weight) => sum + (weight as number), 0) !== 100 ||
    typeof row.minimumMarginBps !== 'number' ||
    !Number.isSafeInteger(row.minimumMarginBps) ||
    row.minimumMarginBps < 0 ||
    row.minimumMarginBps > 10_000 ||
    !safeText(row.backupCapabilityMapJson, 20_000) ||
    !safeText(row.effectiveAt) ||
    !safeText(row.providerPriorityJson, 20_000) ||
    !safeText(row.sourceUpdatedAt) ||
    !safeVersion(row.version) ||
    !isUuidV7(row.versionId) ||
    !['DISABLED', 'SMART_ONLY', 'USER_OPT_IN'].includes(row.failoverMode as string) ||
    !['DRAFT', 'PUBLISHED', 'RETIRED'].includes(row.status as string)
  )
    throw new Error('路由策略响应无效');
  try {
    parseProviderPriority(JSON.parse(row.providerPriorityJson));
    parseBackupCapabilityMap(JSON.parse(row.backupCapabilityMapJson));
  } catch {
    throw new Error('路由策略响应无效');
  }
  let publishPreflight: RoutingPolicyView['publishPreflight'] = null;
  if (row.publishPreflight !== null) {
    const preflight = exact(row.publishPreflight, [
      'diff',
      'expiresAt',
      'impact',
      'previewToken',
      'version',
      'versionId',
    ]);
    if (
      !safeText(preflight.diff, 1000) ||
      !isUtcIso8601Z(preflight.expiresAt as string) ||
      !safeText(preflight.impact, 1000) ||
      !safeText(preflight.previewToken, 500) ||
      preflight.version !== row.version ||
      preflight.versionId !== row.versionId
    )
      throw new Error('路由策略响应无效');
    publishPreflight = Object.freeze(preflight) as NonNullable<
      RoutingPolicyView['publishPreflight']
    >;
  }
  return Object.freeze({
    ...row,
    publishPreflight,
    versions: parseVersions(row.versions),
  }) as RoutingPolicyView;
}

export function parseRoutingSimulation(value: unknown): RoutingSimulation {
  const row = exact(value, ['candidates', 'exclusions', 'requestId', 'sourceUpdatedAt']);
  if (
    !isUuidV7(row.requestId) ||
    !safeText(row.sourceUpdatedAt) ||
    !Array.isArray(row.candidates) ||
    row.candidates.length > 100 ||
    !Array.isArray(row.exclusions) ||
    row.exclusions.length > 100
  )
    throw new Error('路由模拟响应无效');
  const candidates = row.candidates.map((item) => {
    const c = exact(item, [
      'costPoints',
      'marginBps',
      'modelCode',
      'providerName',
      'salePoints',
      'score',
      'scoreExplanation',
      'selected',
    ]);
    if (
      !isPoints(c.costPoints as string) ||
      !isPoints(c.salePoints as string) ||
      typeof c.marginBps !== 'number' ||
      !Number.isSafeInteger(c.marginBps) ||
      typeof c.score !== 'number' ||
      !Number.isFinite(c.score) ||
      typeof c.selected !== 'boolean' ||
      !safeText(c.modelCode) ||
      !safeText(c.providerName)
    )
      throw new Error('路由模拟响应无效');
    return Object.freeze({ ...c, scoreExplanation: stringArray(c.scoreExplanation, 20) });
  });
  const exclusions = row.exclusions.map((item) => {
    const e = exact(item, ['modelCode', 'reason']);
    if (!safeText(e.modelCode) || !safeText(e.reason)) throw new Error('路由模拟响应无效');
    return Object.freeze(e);
  });
  return Object.freeze({
    candidates: Object.freeze(candidates),
    exclusions: Object.freeze(exclusions),
    requestId: row.requestId,
    sourceUpdatedAt: row.sourceUpdatedAt,
  }) as RoutingSimulation;
}

export function parseTaskDetail(value: unknown): TaskDetail {
  const row = plainRecord(value);
  const required = [
    'allowedOperations',
    'assignedAdminIds',
    'attempt',
    'duplicatePurchaseRisk',
    'financial',
    'id',
    'operationPreviews',
    'ownerAdminId',
    'parameterSnapshot',
    'publicError',
    'queue',
    'sourceUpdatedAt',
    'status',
    'timeline',
    'userIdMasked',
    'version',
  ];
  const optional = ['attemptHistory', 'normalizedProviderResponse', 'rawExchange'];
  const keys = Object.keys(row);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw new Error('任务响应无效');
  if (
    !isUuidV7(row.id) ||
    !safeVersion(row.version) ||
    !safeText(row.status) ||
    !safeText(row.sourceUpdatedAt) ||
    !safeText(row.userIdMasked)
  )
    throw new Error('任务响应无效');
  if (
    !Array.isArray(row.allowedOperations) ||
    row.allowedOperations.length > 5 ||
    new Set(row.allowedOperations).size !== row.allowedOperations.length ||
    row.allowedOperations.some(
      (op) =>
        !['RETRY_PROVIDER', 'SWITCH_PROVIDER', 'CANCEL', 'REFUND', 'REPAIR'].includes(op as string),
    )
  )
    throw new Error('任务响应无效');
  const assignedAdminIds = stringArray(row.assignedAdminIds, 100);
  if (assignedAdminIds.some((id) => !isUuidV7(id))) throw new Error('任务响应无效');
  const attempt = exact(row.attempt, [
    'acceptance',
    'circuitState',
    'externalTaskIdMasked',
    'number',
    'providerName',
  ]);
  const financial = exact(row.financial, [
    'chargedPoints',
    'costPoints',
    'frozenPoints',
    'refundedPoints',
  ]);
  if (
    !['NOT_ACCEPTED', 'ACCEPTED', 'AMBIGUOUS'].includes(attempt.acceptance as string) ||
    !['CLOSED', 'OPEN', 'HALF_OPEN'].includes(attempt.circuitState as string) ||
    !safeText(attempt.providerName) ||
    !safeVersion(attempt.number) ||
    (attempt.externalTaskIdMasked !== null && !safeText(attempt.externalTaskIdMasked))
  )
    throw new Error('任务响应无效');
  for (const key of ['chargedPoints', 'costPoints', 'frozenPoints', 'refundedPoints'])
    if (!isPoints(financial[key] as string)) throw new Error('任务响应无效');
  if (
    (row.ownerAdminId !== null && !isUuidV7(row.ownerAdminId)) ||
    (row.publicError !== null && !safeText(row.publicError)) ||
    typeof row.duplicatePurchaseRisk !== 'boolean' ||
    !Array.isArray(row.timeline) ||
    row.timeline.length > 500 ||
    !row.parameterSnapshot ||
    typeof row.parameterSnapshot !== 'object'
  )
    throw new Error('任务响应无效');
  if (row.queue !== null) {
    const queue = exact(row.queue, ['enqueuedAt', 'priority', 'shard']);
    if (
      !safeText(queue.enqueuedAt) ||
      !safeText(queue.shard) ||
      typeof queue.priority !== 'number' ||
      !Number.isSafeInteger(queue.priority)
    )
      throw new Error('任务响应无效');
  }
  for (const item of row.timeline) {
    const timelineItem = exact(item, ['at', 'code', 'label']);
    if (!safeText(timelineItem.at) || !safeText(timelineItem.code) || !safeText(timelineItem.label))
      throw new Error('任务响应无效');
  }
  if (row.attemptHistory !== undefined) {
    if (!Array.isArray(row.attemptHistory) || row.attemptHistory.length > 100)
      throw new Error('任务响应无效');
    for (const item of row.attemptHistory) {
      const history = exact(item, ['acceptance', 'at', 'number', 'outcome', 'providerName']);
      if (
        !['NOT_ACCEPTED', 'ACCEPTED', 'AMBIGUOUS'].includes(history.acceptance as string) ||
        !safeText(history.at) ||
        !safeVersion(history.number) ||
        !safeText(history.outcome) ||
        !safeText(history.providerName)
      )
        throw new Error('任务响应无效');
    }
  }
  if (row.normalizedProviderResponse !== undefined) {
    const response = exact(row.normalizedProviderResponse, ['code', 'message', 'status']);
    if (!safeText(response.code) || !safeText(response.message, 500) || !safeText(response.status))
      throw new Error('任务响应无效');
  }
  validateJsonTree(row.parameterSnapshot);
  const operations: readonly unknown[] = row.allowedOperations;
  if (!Array.isArray(row.operationPreviews) || row.operationPreviews.length !== operations.length)
    throw new Error('任务响应无效');
  const operationPreviews = row.operationPreviews.map((value) => {
    const preview = exact(value, ['impact', 'operation', 'preflightToken', 'purchaseSafety']);
    if (
      !operations.includes(preview.operation) ||
      !safeText(preview.impact, 500) ||
      !safeText(preview.preflightToken, 500) ||
      !['NOT_APPLICABLE', 'NOT_ACCEPTED', 'CONFIRMED_NO_CHARGE'].includes(
        preview.purchaseSafety as string,
      )
    )
      throw new Error('任务响应无效');
    return Object.freeze(preview);
  });
  return Object.freeze({
    ...row,
    allowedOperations: Object.freeze(operations.map((operation) => operation as TaskOperation)),
    assignedAdminIds,
    operationPreviews: Object.freeze(operationPreviews),
  }) as TaskDetail;
}

export async function loadPricingView(
  dependencies: Readonly<{ context?: ServerGuardContext; port: PricingOperationsPort }>,
) {
  const auth = await requireAdminAuthorization('pricing:read', dependencies.context);
  const requestContext = createOutboundRequestContext();
  return parsePricingView(
    await dependencies.port.getPricing({
      requestContext,
      scope: auth.claims.dataScope,
      trustedSessionToken: auth.trustedSessionToken,
    }),
  );
}
export async function loadRoutingView(
  dependencies: Readonly<{ context?: ServerGuardContext; port: RoutingOperationsPort }>,
) {
  const auth = await requireAdminAuthorization('routing:read', dependencies.context);
  return parseRoutingPolicyView(
    await dependencies.port.getRouting({
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      trustedSessionToken: auth.trustedSessionToken,
    }),
  );
}
export async function simulateRouting(
  dependencies: Readonly<{ context?: ServerGuardContext; port: RoutingOperationsPort }>,
  parameters: Readonly<Record<string, unknown>>,
) {
  validateJsonTree(parameters);
  const auth = await requireAdminAuthorization('routing:simulate', dependencies.context);
  const requestContext = createOutboundRequestContext();
  const requestedVersionId = parameters.routingVersionId;
  const requestedVersion = parameters.expectedVersion;
  if (!isUuidV7(requestedVersionId) || !safeVersion(requestedVersion))
    throw new Error('路由版本绑定无效');
  const base = {
    requestContext,
    scope: auth.claims.dataScope,
    trustedSessionToken: auth.trustedSessionToken,
  };
  const current = parseRoutingPolicyView(await dependencies.port.getRouting(base));
  if (current.versionId !== requestedVersionId || current.version !== requestedVersion)
    throw new Error('路由版本已变化');
  return parseRoutingSimulation(
    await dependencies.port.simulate({
      ...base,
      parameters: Object.freeze({
        ...parameters,
        expectedVersion: current.version,
        routingVersionId: current.versionId,
      }),
    }),
  );
}
export async function loadTaskDirectoryView(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    cursor?: string;
    port: TaskOperationsPort;
    query?: string;
    status?: string;
  }>,
): Promise<TaskDirectory> {
  const auth = await requireAdminAuthorization('tasks:read', dependencies.context);
  if (!dependencies.port.listTasks) throw new Error('任务目录服务不可用');
  const query = dependencies.query?.trim() ?? '';
  const status = dependencies.status?.trim() ?? '';
  const cursor = dependencies.cursor?.trim() ?? '';
  if (
    query.length > 100 ||
    status.length > 40 ||
    cursor.length > 500 ||
    /[\p{C}]/u.test(`${query}${status}${cursor}`)
  )
    throw new Error('任务查询条件无效');
  const payload = exact(
    await dependencies.port.listTasks({
      cursor,
      query,
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      status,
      trustedSessionToken: auth.trustedSessionToken,
    }),
    ['items', 'nextCursor', 'partialFields', 'queue', 'sourceUpdatedAt'],
  );
  if (
    !Array.isArray(payload.items) ||
    payload.items.length > 500 ||
    !safeText(payload.sourceUpdatedAt)
  )
    throw new Error('任务目录响应无效');
  const items = payload.items.map((value) => {
    const row = exact(value, ['id', 'providerName', 'status', 'updatedAt', 'userIdMasked']);
    if (
      !isUuidV7(row.id) ||
      !safeText(row.providerName) ||
      !safeText(row.status) ||
      !safeText(row.updatedAt) ||
      !safeText(row.userIdMasked)
    )
      throw new Error('任务目录响应无效');
    return Object.freeze(row) as TaskSummary;
  });
  const queue = exact(payload.queue, [
    'backlog',
    'concurrencyLimit',
    'defaultPriority',
    'operationPreviews',
    'paused',
    'rateLimitPerMinute',
    'running',
    'version',
  ]);
  if (
    typeof queue.backlog !== 'number' ||
    !Number.isSafeInteger(queue.backlog) ||
    queue.backlog < 0 ||
    typeof queue.concurrencyLimit !== 'number' ||
    !Number.isSafeInteger(queue.concurrencyLimit) ||
    queue.concurrencyLimit < 1 ||
    typeof queue.defaultPriority !== 'number' ||
    !Number.isSafeInteger(queue.defaultPriority) ||
    queue.defaultPriority < 0 ||
    queue.defaultPriority > 100 ||
    !safeVersion(queue.version) ||
    !Array.isArray(queue.operationPreviews) ||
    queue.operationPreviews.length > 3 ||
    typeof queue.running !== 'number' ||
    !Number.isSafeInteger(queue.running) ||
    queue.running < 0 ||
    typeof queue.rateLimitPerMinute !== 'number' ||
    !Number.isSafeInteger(queue.rateLimitPerMinute) ||
    queue.rateLimitPerMinute < 0 ||
    typeof queue.paused !== 'boolean' ||
    (payload.nextCursor !== null && !safeText(payload.nextCursor, 500))
  )
    throw new Error('任务目录响应无效');
  const queueOperations = new Set<string>();
  const operationPreviews = queue.operationPreviews.map((value) => {
    const preview = exact(value, ['action', 'expiresAt', 'impact', 'preflightToken', 'version']);
    if (
      !['PAUSE', 'RESUME', 'UPDATE_LIMITS'].includes(preview.action as string) ||
      queueOperations.has(preview.action as string) ||
      !isUtcIso8601Z(preview.expiresAt as string) ||
      !safeText(preview.impact, 500) ||
      !safeText(preview.preflightToken, 500) ||
      preview.version !== queue.version
    )
      throw new Error('任务目录响应无效');
    queueOperations.add(preview.action as string);
    return Object.freeze(preview);
  });
  return Object.freeze({
    items: Object.freeze(items),
    nextCursor: payload.nextCursor,
    partialFields: stringArray(payload.partialFields, 20),
    queue: Object.freeze({ ...queue, operationPreviews: Object.freeze(operationPreviews) }),
    sourceUpdatedAt: payload.sourceUpdatedAt,
  }) as TaskDirectory;
}
export async function loadTaskDetailView(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    includeRaw?: boolean;
    port: TaskOperationsPort;
    taskId: string;
  }>,
) {
  if (!isUuidV7(dependencies.taskId)) throw new Error('任务 ID 无效');
  const auth = await requireAdminAuthorization('tasks:read', dependencies.context);
  const base = {
    requestContext: createOutboundRequestContext(),
    scope: auth.claims.dataScope,
    trustedSessionToken: auth.trustedSessionToken,
  };
  const task = parseTaskDetail(
    await dependencies.port.getTask({ ...base, taskId: dependencies.taskId }),
  );
  assertAdminDataScope(auth.claims, task);
  const publicTask: TaskDetail = Object.freeze({
    allowedOperations: task.allowedOperations,
    assignedAdminIds: task.assignedAdminIds,
    attempt: task.attempt,
    ...(task.attemptHistory === undefined ? {} : { attemptHistory: task.attemptHistory }),
    duplicatePurchaseRisk: task.duplicatePurchaseRisk,
    financial: task.financial,
    id: task.id,
    ...(task.normalizedProviderResponse === undefined
      ? {}
      : { normalizedProviderResponse: task.normalizedProviderResponse }),
    operationPreviews: task.operationPreviews,
    ownerAdminId: task.ownerAdminId,
    parameterSnapshot: task.parameterSnapshot,
    publicError: task.publicError,
    queue: task.queue,
    sourceUpdatedAt: task.sourceUpdatedAt,
    status: task.status,
    timeline: task.timeline,
    userIdMasked: task.userIdMasked,
    version: task.version,
  });
  if (
    !dependencies.includeRaw ||
    !hasPermission(auth.claims, 'tasks:raw-read') ||
    !dependencies.port.getRaw
  )
    return Object.freeze(publicTask) as TaskDetail;
  const raw = await dependencies.port.getRaw({ ...base, taskId: dependencies.taskId });
  validateJsonTree(raw);
  return Object.freeze({
    ...publicTask,
    rawExchange: redactRawPayload(plainRecord(raw)),
  }) as TaskDetail;
}

export async function loadTaskRawView(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    port: TaskOperationsPort;
    taskId: string;
  }>,
) {
  const task = await loadTaskDetailView({ ...dependencies, includeRaw: true });
  if (task.rawExchange === undefined) throw new Error('原始报文不可用');
  return task.rawExchange;
}

export function createPricingPreviewAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: PricingOperationsPort }>,
) {
  return async (form: FormData) => {
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'effectiveAt',
            'expectedVersion',
            'markupBps',
            'ruleId',
            'salePoints',
            'strategy',
            'tiersJson',
            'versionId',
          ].includes(key),
      )
    )
      throw new Error('定价预检字段无效');
    const auth = await requireAdminAnyAuthorization(
      ['pricing:write', 'pricing:publish'],
      dependencies.context,
    );
    const versionId = formText(form, 'versionId', 64);
    const expected = formText(form, 'expectedVersion', 12);
    const ruleId = formText(form, 'ruleId', 100);
    if (!isUuidV7(versionId) || !expected || !/^\d{1,12}$/.test(expected) || !ruleId)
      throw new Error('定价预检字段无效');
    const expectedVersion = Number(expected);
    const base = {
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      trustedSessionToken: auth.trustedSessionToken,
    };
    let effectiveAt: string;
    let markupBps: number;
    let salePoints: string;
    let strategy: 'FIXED' | 'MARKUP' | 'TIERED';
    let tiers: unknown;
    if (hasPermission(auth.claims, 'pricing:write')) {
      const submittedSalePoints = formText(form, 'salePoints', 60);
      const submittedStrategy = formText(form, 'strategy', 16);
      const submittedMarkupBps = formInteger(form, 'markupBps', 100_000);
      const submittedTiersJson = formText(form, 'tiersJson', 20_000);
      const submittedEffectiveAt = formText(form, 'effectiveAt', 40);
      if (
        !submittedSalePoints ||
        !isPoints(submittedSalePoints) ||
        !submittedStrategy ||
        !['FIXED', 'MARKUP', 'TIERED'].includes(submittedStrategy) ||
        submittedMarkupBps === null ||
        !submittedTiersJson ||
        !submittedEffectiveAt ||
        !isUtcIso8601Z(submittedEffectiveAt)
      )
        throw new Error('定价预检字段无效');
      effectiveAt = submittedEffectiveAt;
      markupBps = submittedMarkupBps;
      salePoints = submittedSalePoints;
      strategy = submittedStrategy as 'FIXED' | 'MARKUP' | 'TIERED';
      tiers = parsePricingTiers(submittedTiersJson, strategy);
    } else {
      const current = parsePricingView(await dependencies.port.getPricing(base));
      const authoritativeRule = current.rules.find((rule) => rule.id === ruleId);
      if (
        current.status !== 'DRAFT' ||
        current.versionId !== versionId ||
        current.version !== expectedVersion ||
        !authoritativeRule
      )
        throw new Error('定价版本已变化');
      effectiveAt = current.effectiveAt;
      markupBps = authoritativeRule.markupBps;
      salePoints = authoritativeRule.salePoints;
      strategy = authoritativeRule.strategy;
      tiers = parsePricingTiers(authoritativeRule.tiersJson, strategy);
    }
    const response = exact(
      await dependencies.port.preview({
        effectiveAt,
        expectedVersion,
        markupBps,
        ...base,
        ruleId,
        salePoints,
        strategy,
        tiers,
        versionId,
      }),
      ['expiresAt', 'previewToken', 'version', 'versionId'],
    );
    if (
      !isUtcIso8601Z(response.expiresAt as string) ||
      Date.parse(response.expiresAt as string) <= Date.now() ||
      !safeText(response.previewToken, 500) ||
      response.versionId !== versionId ||
      response.version !== expectedVersion
    )
      throw new Error('定价预检回执无效');
    return Object.freeze(response) as Readonly<{
      expiresAt: string;
      previewToken: string;
      version: number;
      versionId: string;
    }>;
  };
}

export function createPricingSaveAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: PricingOperationsPort }>,
) {
  return async (form: FormData) => {
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'effectiveAt',
            'expectedVersion',
            'intentId',
            'markupBps',
            'reason',
            'ruleId',
            'salePoints',
            'strategy',
            'tiersJson',
            'versionId',
          ].includes(key),
      )
    )
      throw new Error('定价草稿字段无效');
    const auth = await requireAdminAuthorization('pricing:write', dependencies.context);
    const versionId = formText(form, 'versionId', 64);
    const intentId = formText(form, 'intentId', 64);
    const expected = formText(form, 'expectedVersion', 12);
    const reason = formText(form, 'reason', 200);
    const salePoints = formText(form, 'salePoints', 60);
    const ruleId = formText(form, 'ruleId', 100);
    const strategy = formText(form, 'strategy', 16);
    const markupBps = formInteger(form, 'markupBps', 100_000);
    const tiersJson = formText(form, 'tiersJson', 20_000);
    const effectiveAt = formText(form, 'effectiveAt', 40);
    if (
      !isUuidV7(versionId) ||
      !isUuidV7(intentId) ||
      !expected ||
      !/^\d{1,12}$/.test(expected) ||
      !reason ||
      !salePoints ||
      !ruleId ||
      !strategy ||
      !['FIXED', 'MARKUP', 'TIERED'].includes(strategy) ||
      markupBps === null ||
      !tiersJson ||
      !isPoints(salePoints) ||
      !effectiveAt ||
      !isUtcIso8601Z(effectiveAt)
    )
      throw new Error('定价草稿字段无效');
    const tiers = parsePricingTiers(tiersJson, strategy as 'FIXED' | 'MARKUP' | 'TIERED');
    return dependencies.port.save({
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      effectiveAt,
      expectedVersion: Number(expected),
      markupBps,
      requestContext: createOutboundRequestContext(),
      ruleId,
      salePoints,
      scope: auth.claims.dataScope,
      trustedSessionToken: auth.trustedSessionToken,
      strategy: strategy as 'FIXED' | 'MARKUP' | 'TIERED',
      tiers,
      versionId,
    });
  };
}

export function createPricingRollbackAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: PricingOperationsPort }>,
) {
  return async (form: FormData) => {
    const auth = await requireAdminAuthorization('pricing:rollback', dependencies.context);
    const versionId = formText(form, 'versionId', 64);
    const targetVersionId = formText(form, 'targetVersionId', 64);
    const intentId = formText(form, 'intentId', 64);
    const expected = formText(form, 'expectedVersion', 12);
    const reason = formText(form, 'reason', 200);
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'confirmed',
            'expectedVersion',
            'intentId',
            'reason',
            'targetVersionId',
            'versionId',
          ].includes(key),
      ) ||
      !isUuidV7(versionId) ||
      !isUuidV7(targetVersionId) ||
      !isUuidV7(intentId) ||
      !expected ||
      !/^\d{1,12}$/.test(expected) ||
      !reason ||
      form.get('confirmed') !== 'true'
    )
      throw new Error('定价回滚字段无效');
    return dependencies.port.rollback({
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      confirmed: true,
      expectedVersion: Number(expected),
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      targetVersionId,
      trustedSessionToken: auth.trustedSessionToken,
      versionId,
    });
  };
}

export function createPricingPublishAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: PricingOperationsPort }>,
) {
  return async (form: FormData) => {
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'confirmed',
            'expectedVersion',
            'intentId',
            'previewToken',
            'reason',
            'versionId',
          ].includes(key),
      )
    )
      throw new Error('定价发布字段无效');
    const auth = await requireAdminAuthorization('pricing:publish', dependencies.context);
    const versionId = formText(form, 'versionId', 64);
    const expected = formText(form, 'expectedVersion', 12);
    const previewToken = formText(form, 'previewToken', 500);
    const reason = formText(form, 'reason', 200);
    const intentId = formText(form, 'intentId', 64);
    if (
      !isUuidV7(versionId) ||
      !isUuidV7(intentId) ||
      !expected ||
      !/^\d{1,12}$/.test(expected) ||
      !previewToken ||
      !reason ||
      form.get('confirmed') !== 'true'
    )
      throw new Error('定价发布字段无效');
    return dependencies.port.publish({
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      confirmed: true,
      expectedVersion: Number(expected),
      previewToken,
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      trustedSessionToken: auth.trustedSessionToken,
      versionId,
    });
  };
}

function validateJsonTree(value: unknown, depth = 0, budget = { nodes: 0 }): void {
  budget.nodes += 1;
  if (depth > 12 || budget.nodes > 500) throw new Error('路由模拟参数无效');
  if (
    value === null ||
    typeof value === 'boolean' ||
    (typeof value === 'string' && value.length <= 4000) ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return;
  if (Array.isArray(value)) {
    if (value.length > 100) throw new Error('路由模拟参数无效');
    for (const item of value) validateJsonTree(item, depth + 1, budget);
    return;
  }
  const record = plainRecord(value);
  if (Object.keys(record).length > 100) throw new Error('路由模拟参数无效');
  for (const [key, item] of Object.entries(record)) {
    if (!safeText(key, 100)) throw new Error('路由模拟参数无效');
    validateJsonTree(item, depth + 1, budget);
  }
}

function formInteger(form: FormData, key: string, maximum: number): number | null {
  const value = formText(form, key, 12);
  if (!value || !/^\d{1,12}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
}
export function createRoutingSaveAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: RoutingOperationsPort }>,
) {
  return async (form: FormData) => {
    const allowedKeys = [
      'backupCapabilityMapJson',
      'effectiveAt',
      'expectedVersion',
      'failoverMode',
      'intentId',
      'minimumMarginBps',
      'priceWeight',
      'providerPriorityJson',
      'qualityWeight',
      'reason',
      'speedWeight',
      'versionId',
    ];
    if ([...form.keys()].some((key) => !allowedKeys.includes(key)))
      throw new Error('路由草稿字段无效');
    const auth = await requireAdminAuthorization('routing:write', dependencies.context);
    const versionId = formText(form, 'versionId', 64);
    const intentId = formText(form, 'intentId', 64);
    const reason = formText(form, 'reason', 200);
    const effectiveAt = formText(form, 'effectiveAt', 40);
    const failoverMode = formText(form, 'failoverMode', 24);
    const providerPriorityJson = formText(form, 'providerPriorityJson', 20_000);
    const backupCapabilityMapJson = formText(form, 'backupCapabilityMapJson', 20_000);
    const expectedVersion = formInteger(form, 'expectedVersion', 1_000_000);
    const minimumMarginBps = formInteger(form, 'minimumMarginBps', 10_000);
    const qualityWeight = formInteger(form, 'qualityWeight', 100);
    const speedWeight = formInteger(form, 'speedWeight', 100);
    const priceWeight = formInteger(form, 'priceWeight', 100);
    if (
      !isUuidV7(versionId) ||
      !isUuidV7(intentId) ||
      !reason ||
      !effectiveAt ||
      !isUtcIso8601Z(effectiveAt) ||
      !failoverMode ||
      !providerPriorityJson ||
      !backupCapabilityMapJson ||
      !['DISABLED', 'SMART_ONLY', 'USER_OPT_IN'].includes(failoverMode) ||
      expectedVersion === null ||
      minimumMarginBps === null ||
      qualityWeight === null ||
      speedWeight === null ||
      priceWeight === null ||
      qualityWeight + speedWeight + priceWeight !== 100
    )
      throw new Error('路由草稿字段无效');
    let providerPriority: unknown;
    let backupCapabilityMap: unknown;
    try {
      providerPriority = parseProviderPriority(JSON.parse(providerPriorityJson));
      backupCapabilityMap = parseBackupCapabilityMap(JSON.parse(backupCapabilityMapJson));
    } catch {
      throw new Error('路由优先级或备援映射无效');
    }
    return dependencies.port.save({
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      backupCapabilityMap,
      effectiveAt,
      expectedVersion,
      failoverMode,
      minimumMarginBps,
      priceWeight,
      providerPriority,
      qualityWeight,
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      speedWeight,
      trustedSessionToken: auth.trustedSessionToken,
      versionId,
    });
  };
}
export function createRoutingPreviewAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: RoutingOperationsPort }>,
) {
  return async (form: FormData) => {
    const auth = await requireAdminAnyAuthorization(
      ['routing:write', 'routing:publish'],
      dependencies.context,
    );
    const versionId = formText(form, 'versionId', 64);
    const expectedVersion = formInteger(form, 'expectedVersion', 1_000_000);
    if (
      [...form.keys()].some((key) => !['expectedVersion', 'versionId'].includes(key)) ||
      !isUuidV7(versionId) ||
      expectedVersion === null
    )
      throw new Error('路由预检字段无效');
    const response = exact(
      await dependencies.port.preview({
        expectedVersion,
        requestContext: createOutboundRequestContext(),
        scope: auth.claims.dataScope,
        trustedSessionToken: auth.trustedSessionToken,
        versionId,
      }),
      ['diff', 'expiresAt', 'impact', 'previewToken', 'version', 'versionId'],
    );
    if (
      !safeText(response.diff, 1000) ||
      !safeText(response.expiresAt) ||
      !safeText(response.impact, 1000) ||
      !safeText(response.previewToken, 500) ||
      response.version !== expectedVersion ||
      response.versionId !== versionId
    )
      throw new Error('路由预检回执无效');
    return Object.freeze(response);
  };
}
export function createRoutingPublishAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: RoutingOperationsPort }>,
) {
  return async (form: FormData) => {
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'confirmed',
            'expectedVersion',
            'intentId',
            'previewToken',
            'reason',
            'versionId',
          ].includes(key),
      )
    )
      throw new Error('路由发布字段无效');
    const auth = await requireAdminAuthorization('routing:publish', dependencies.context);
    const versionId = formText(form, 'versionId', 64);
    const intentId = formText(form, 'intentId', 64);
    const reason = formText(form, 'reason', 200);
    const previewToken = formText(form, 'previewToken', 500);
    const expectedVersion = formInteger(form, 'expectedVersion', 1_000_000);
    if (
      !isUuidV7(versionId) ||
      !isUuidV7(intentId) ||
      !reason ||
      !previewToken ||
      expectedVersion === null ||
      form.get('confirmed') !== 'true'
    )
      throw new Error('路由发布字段无效');
    const current = parseRoutingPolicyView(
      await dependencies.port.getRouting({
        requestContext: createOutboundRequestContext(),
        scope: auth.claims.dataScope,
        trustedSessionToken: auth.trustedSessionToken,
      }),
    );
    const preflightExpiresAt = current.publishPreflight?.expiresAt;
    const preflightExpiresMs = preflightExpiresAt ? Date.parse(preflightExpiresAt) : Number.NaN;
    if (
      current.version !== expectedVersion ||
      current.versionId !== versionId ||
      current.status !== 'DRAFT' ||
      current.publishPreflight?.previewToken !== previewToken ||
      !Number.isFinite(preflightExpiresMs) ||
      preflightExpiresMs <= Date.now()
    )
      throw new Error('路由预检已失效');
    return dependencies.port.publish({
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      confirmed: true,
      expectedVersion,
      previewToken,
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      trustedSessionToken: auth.trustedSessionToken,
      versionId,
    });
  };
}
export function createRoutingRollbackAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: RoutingOperationsPort }>,
) {
  return async (form: FormData) => {
    if (
      [...form.keys()].some(
        (key) =>
          ![
            'confirmed',
            'expectedVersion',
            'intentId',
            'reason',
            'targetVersionId',
            'versionId',
          ].includes(key),
      )
    )
      throw new Error('路由回滚字段无效');
    const auth = await requireAdminAuthorization('routing:rollback', dependencies.context);
    const versionId = formText(form, 'versionId', 64);
    const targetVersionId = formText(form, 'targetVersionId', 64);
    const intentId = formText(form, 'intentId', 64);
    const reason = formText(form, 'reason', 200);
    const expectedVersion = formInteger(form, 'expectedVersion', 1_000_000);
    if (
      !isUuidV7(versionId) ||
      !isUuidV7(targetVersionId) ||
      !isUuidV7(intentId) ||
      !reason ||
      expectedVersion === null ||
      form.get('confirmed') !== 'true'
    )
      throw new Error('路由回滚字段无效');
    return dependencies.port.rollback({
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      confirmed: true,
      expectedVersion,
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      targetVersionId,
      trustedSessionToken: auth.trustedSessionToken,
      versionId,
    });
  };
}

const actionPermission: Readonly<Record<TaskOperation, string>> = {
  RETRY_PROVIDER: 'tasks:retry',
  SWITCH_PROVIDER: 'tasks:switch',
  CANCEL: 'tasks:cancel',
  REFUND: 'tasks:refund',
  REPAIR: 'tasks:repair',
};
function formText(form: FormData, key: string, max: number) {
  const value = form.get(key);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max && !/[\p{C}]/u.test(trimmed) ? trimmed : null;
}
export function createTaskAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: TaskOperationsPort }>,
) {
  return async (form: FormData) => {
    const allowedKeys = [
      'action',
      'confirmed',
      'expectedVersion',
      'impactToken',
      'intentId',
      'reason',
      'taskId',
    ];
    if ([...form.keys()].some((key) => !allowedKeys.includes(key)))
      throw new Error('任务操作字段无效');
    const action = formText(form, 'action', 32) as TaskOperation | null;
    if (!action || !(action in actionPermission)) throw new Error('任务操作无效');
    const auth = await requireAdminAuthorization(actionPermission[action], dependencies.context);
    const taskId = formText(form, 'taskId', 64);
    const intentId = formText(form, 'intentId', 64);
    const impactToken = formText(form, 'impactToken', 500);
    const reason = formText(form, 'reason', 200);
    const expectedVersionText = formText(form, 'expectedVersion', 12);
    if (
      !isUuidV7(taskId) ||
      !isUuidV7(intentId) ||
      !impactToken ||
      !reason ||
      !expectedVersionText ||
      !/^\d{1,12}$/.test(expectedVersionText) ||
      form.get('confirmed') !== 'true' ||
      !dependencies.port.execute
    )
      throw new Error('任务操作字段无效');
    const expectedVersion = Number(expectedVersionText);
    const base = {
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      trustedSessionToken: auth.trustedSessionToken,
    };
    const task = parseTaskDetail(await dependencies.port.getTask({ ...base, taskId }));
    assertAdminDataScope(auth.claims, task);
    if (task.version !== expectedVersion) throw new Error('任务版本已变化');
    if (!task.allowedOperations.includes(action)) throw new Error('当前任务不允许此操作');
    const preview = task.operationPreviews.find((item) => item.operation === action);
    if (!preview || preview.preflightToken !== impactToken) throw new Error('任务影响预览已失效');
    if (
      (action === 'RETRY_PROVIDER' || action === 'SWITCH_PROVIDER') &&
      (task.duplicatePurchaseRisk ||
        (preview.purchaseSafety !== 'NOT_ACCEPTED' &&
          preview.purchaseSafety !== 'CONFIRMED_NO_CHARGE'))
    )
      throw new Error('重复采购风险阻止此操作');
    return dependencies.port.execute({
      ...base,
      action,
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      confirmed: true,
      expectedVersion,
      impactToken,
      taskId,
    });
  };
}

const queueActionPermission = Object.freeze({
  PAUSE: 'tasks:queue-pause',
  RESUME: 'tasks:queue-resume',
  UPDATE_LIMITS: 'tasks:priority-write',
} as const);

export function createQueueAction(
  dependencies: Readonly<{ context?: ServerGuardContext; port: TaskOperationsPort }>,
) {
  return async (form: FormData) => {
    const action = formText(form, 'action', 24) as keyof typeof queueActionPermission | null;
    if (!action || !(action in queueActionPermission)) throw new Error('队列操作无效');
    const allowedKeys =
      action === 'UPDATE_LIMITS'
        ? [
            'action',
            'confirmed',
            'concurrencyLimit',
            'defaultPriority',
            'expectedPaused',
            'expectedVersion',
            'impactToken',
            'intentId',
            'rateLimitPerMinute',
            'reason',
          ]
        : [
            'action',
            'confirmed',
            'expectedPaused',
            'expectedVersion',
            'impactToken',
            'intentId',
            'reason',
          ];
    if ([...form.keys()].some((key) => !allowedKeys.includes(key)))
      throw new Error('队列操作字段无效');
    const auth = await requireAdminAuthorization(
      queueActionPermission[action],
      dependencies.context,
    );
    const intentId = formText(form, 'intentId', 64);
    const reason = formText(form, 'reason', 200);
    const expectedPausedText = formText(form, 'expectedPaused', 5);
    const expectedVersion = formInteger(form, 'expectedVersion', 1_000_000_000);
    const impactToken = formText(form, 'impactToken', 500);
    if (
      !dependencies.port.executeQueue ||
      !dependencies.port.listTasks ||
      !isUuidV7(intentId) ||
      !reason ||
      (expectedPausedText !== 'true' && expectedPausedText !== 'false') ||
      expectedVersion === null ||
      !impactToken ||
      form.get('confirmed') !== 'true'
    )
      throw new Error('队列操作字段无效');
    const expectedPaused = expectedPausedText === 'true';
    const authoritative = await loadTaskDirectoryView({
      ...(dependencies.context ? { context: dependencies.context } : {}),
      port: dependencies.port,
    });
    const preview = authoritative.queue.operationPreviews.find((item) => item.action === action);
    const previewExpiresMs = preview ? Date.parse(preview.expiresAt) : Number.NaN;
    if (
      authoritative.queue.version !== expectedVersion ||
      authoritative.queue.paused !== expectedPaused ||
      !preview ||
      preview.preflightToken !== impactToken ||
      !Number.isFinite(previewExpiresMs) ||
      previewExpiresMs <= Date.now()
    )
      throw new Error('队列状态已变化');
    const base = {
      actorId: auth.claims.subjectId,
      audit: { idempotencyKey: intentId, reason },
      confirmed: true,
      expectedPaused,
      expectedVersion,
      impactToken,
      requestContext: createOutboundRequestContext(),
      scope: auth.claims.dataScope,
      trustedSessionToken: auth.trustedSessionToken,
    } as const;
    if (action === 'PAUSE' || action === 'RESUME')
      return dependencies.port.executeQueue({ ...base, action });
    const concurrencyLimit = formInteger(form, 'concurrencyLimit', 100_000);
    const defaultPriority = formInteger(form, 'defaultPriority', 100);
    const rateLimitPerMinute = formInteger(form, 'rateLimitPerMinute', 10_000_000);
    if (
      concurrencyLimit === null ||
      concurrencyLimit < 1 ||
      defaultPriority === null ||
      rateLimitPerMinute === null
    )
      throw new Error('队列操作字段无效');
    return dependencies.port.executeQueue({
      ...base,
      action,
      concurrencyLimit,
      defaultPriority,
      rateLimitPerMinute,
    });
  };
}
