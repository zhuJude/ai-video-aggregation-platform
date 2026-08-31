import type { EventEnvelope } from '@repo/contracts/common';

export interface MetricTotals {
  rechargePoints: bigint;
  rechargeAmountMinor: bigint;
  consumedPoints: bigint;
  revenueMinor: bigint;
  providerCostMinor: bigint;
  successfulTasks: number;
  failedTasks: number;
}

export interface DailyMetric extends MetricTotals {
  date: string;
  marginNumeratorMinor: bigint;
  marginDenominatorMinor: bigint;
  taskDurationMsTotal: bigint;
  taskDurationSamples: number;
}

export interface ProjectionCheckpoint {
  eventId: string;
  projectedThrough: string;
  processedAt: string;
}

export interface ProviderDailyMetric {
  date: string;
  providerId: string;
  successfulTasks: number;
  failedTasks: number;
  providerCostMinor: bigint;
  durationMsTotal: bigint;
  durationSamples: number;
}

export interface ModelDailyMetric {
  date: string;
  modelId: string;
  successfulTasks: number;
  failedTasks: number;
  consumedPoints: bigint;
  revenueMinor: bigint;
  providerCostMinor: bigint;
}

export interface UserSegmentMetric {
  date: string;
  segment: string;
  acquiredUsers: number;
  activeUsers: number;
  retainedUsers: number;
}

interface MetricContribution extends MetricTotals {
  date: string;
  providerId?: string;
  modelId?: string;
  durationMs: bigint;
  durationSamples: number;
  segment?: string;
  acquiredUsers: number;
  activeUsers: number;
  retainedUsers: number;
  realtimeKey?: string;
}

interface VersionState {
  daily: Map<string, DailyMetric>;
  providers: Map<string, ProviderDailyMetric>;
  models: Map<string, ModelDailyMetric>;
  segments: Map<string, UserSegmentMetric>;
  realtime: Map<string, bigint>;
  processed: Map<string, MetricContribution | undefined>;
  reversed: Set<string>;
  checkpoint?: ProjectionCheckpoint;
}

export interface RebuildStatus {
  status: 'IDLE' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  version: number;
  sourceCount?: number;
  reason?: string;
}

const ZERO_TOTALS: MetricTotals = {
  rechargePoints: 0n,
  rechargeAmountMinor: 0n,
  consumedPoints: 0n,
  revenueMinor: 0n,
  providerCostMinor: 0n,
  successfulTasks: 0,
  failedTasks: 0,
};

function emptyDaily(date: string): DailyMetric {
  return {
    date,
    ...ZERO_TOTALS,
    marginNumeratorMinor: 0n,
    marginDenominatorMinor: 0n,
    taskDurationMsTotal: 0n,
    taskDurationSamples: 0,
  };
}

function emptyProvider(date: string, providerId: string): ProviderDailyMetric {
  return {
    date,
    providerId,
    successfulTasks: 0,
    failedTasks: 0,
    providerCostMinor: 0n,
    durationMsTotal: 0n,
    durationSamples: 0,
  };
}

function emptyModel(date: string, modelId: string): ModelDailyMetric {
  return {
    date,
    modelId,
    successfulTasks: 0,
    failedTasks: 0,
    consumedPoints: 0n,
    revenueMinor: 0n,
    providerCostMinor: 0n,
  };
}

function emptySegment(date: string, segment: string): UserSegmentMetric {
  return { date, segment, acquiredUsers: 0, activeUsers: 0, retainedUsers: 0 };
}

function dimensionKey(date: string, id: string): string {
  return `${date}:${id}`;
}

function cloneDaily(metric: DailyMetric): DailyMetric {
  return { ...metric };
}

function cloneVersion(state: VersionState): VersionState {
  return {
    daily: new Map([...state.daily].map(([date, metric]) => [date, cloneDaily(metric)])),
    providers: new Map([...state.providers].map(([key, metric]) => [key, { ...metric }])),
    models: new Map([...state.models].map(([key, metric]) => [key, { ...metric }])),
    segments: new Map([...state.segments].map(([key, metric]) => [key, { ...metric }])),
    realtime: new Map(state.realtime),
    processed: new Map(state.processed),
    reversed: new Set(state.reversed),
    ...(state.checkpoint === undefined ? {} : { checkpoint: { ...state.checkpoint } }),
  };
}

function bigintField(data: Record<string, unknown>, field: string): bigint {
  const value = data[field];
  if (value === undefined) return 0n;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`${field} must be a non-negative decimal string`);
  }
  return BigInt(value);
}

function numberField(data: Record<string, unknown>, field: string): number {
  const value = data[field];
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function stringField(data: Record<string, unknown>, field: string): string | undefined {
  const value = data[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${field} must be a string`);
  return value;
}

export function businessDate(occurredAt: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(occurredAt));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year ?? ''}-${values.month ?? ''}-${values.day ?? ''}`;
}

function contributionFor(event: EventEnvelope): MetricContribution | undefined {
  if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) {
    throw new Error(`Event ${event.id} data must be an object`);
  }
  const data = event.data as Record<string, unknown>;
  const base: MetricContribution = {
    date: businessDate(event.occurredAt),
    ...ZERO_TOTALS,
    durationMs: 0n,
    durationSamples: 0,
    acquiredUsers: 0,
    activeUsers: 0,
    retainedUsers: 0,
  };
  switch (event.type) {
    case 'payment.recharge-paid.v1':
      return {
        ...base,
        rechargePoints: bigintField(data, 'rechargePoints'),
        rechargeAmountMinor: bigintField(data, 'rechargeAmountMinor'),
      };
    case 'generation.task-settled.v1': {
      const providerId = stringField(data, 'providerId');
      const modelId = stringField(data, 'modelId');
      return {
        ...base,
        consumedPoints: bigintField(data, 'consumedPoints'),
        revenueMinor: bigintField(data, 'revenueMinor'),
        providerCostMinor: bigintField(data, 'providerCostMinor'),
        successfulTasks: 1,
        durationMs: BigInt(numberField(data, 'durationMs')),
        durationSamples: data.durationMs === undefined ? 0 : 1,
        ...(providerId === undefined ? {} : { providerId }),
        ...(modelId === undefined ? {} : { modelId }),
      };
    }
    case 'generation.task-failed.v1': {
      const providerId = stringField(data, 'providerId');
      const modelId = stringField(data, 'modelId');
      return {
        ...base,
        providerCostMinor: bigintField(data, 'providerCostMinor'),
        failedTasks: 1,
        durationMs: BigInt(numberField(data, 'durationMs')),
        durationSamples: data.durationMs === undefined ? 0 : 1,
        ...(providerId === undefined ? {} : { providerId }),
        ...(modelId === undefined ? {} : { modelId }),
      };
    }
    case 'identity.user-registered.v1': {
      const segment = stringField(data, 'segment');
      if (segment === undefined) throw new Error('segment is required');
      return { ...base, segment, acquiredUsers: 1, realtimeKey: 'users_registered' };
    }
    case 'identity.user-active.v1': {
      const segment = stringField(data, 'segment');
      if (segment === undefined) throw new Error('segment is required');
      if (data.retained !== undefined && typeof data.retained !== 'boolean') {
        throw new Error('retained must be a boolean');
      }
      return {
        ...base,
        segment,
        activeUsers: 1,
        retainedUsers: data.retained === true ? 1 : 0,
        realtimeKey: 'users_active',
      };
    }
    default:
      return undefined;
  }
}

function addContribution(
  metric: DailyMetric,
  contribution: MetricContribution,
  sign: 1 | -1,
): void {
  const bigintSign = BigInt(sign);
  metric.rechargePoints += contribution.rechargePoints * bigintSign;
  metric.rechargeAmountMinor += contribution.rechargeAmountMinor * bigintSign;
  metric.consumedPoints += contribution.consumedPoints * bigintSign;
  metric.revenueMinor += contribution.revenueMinor * bigintSign;
  metric.providerCostMinor += contribution.providerCostMinor * bigintSign;
  metric.marginNumeratorMinor +=
    (contribution.revenueMinor - contribution.providerCostMinor) * bigintSign;
  metric.marginDenominatorMinor += contribution.revenueMinor * bigintSign;
  metric.successfulTasks += contribution.successfulTasks * sign;
  metric.failedTasks += contribution.failedTasks * sign;
  metric.taskDurationMsTotal += contribution.durationMs * bigintSign;
  metric.taskDurationSamples += contribution.durationSamples * sign;
}

function applyContribution(
  state: VersionState,
  contribution: MetricContribution,
  sign: 1 | -1,
): void {
  const daily = state.daily.get(contribution.date) ?? emptyDaily(contribution.date);
  addContribution(daily, contribution, sign);
  state.daily.set(contribution.date, daily);

  if (contribution.providerId !== undefined) {
    const key = dimensionKey(contribution.date, contribution.providerId);
    const provider =
      state.providers.get(key) ?? emptyProvider(contribution.date, contribution.providerId);
    provider.successfulTasks += contribution.successfulTasks * sign;
    provider.failedTasks += contribution.failedTasks * sign;
    provider.providerCostMinor += contribution.providerCostMinor * BigInt(sign);
    provider.durationMsTotal += contribution.durationMs * BigInt(sign);
    provider.durationSamples += contribution.durationSamples * sign;
    state.providers.set(key, provider);
  }

  if (contribution.modelId !== undefined) {
    const key = dimensionKey(contribution.date, contribution.modelId);
    const model = state.models.get(key) ?? emptyModel(contribution.date, contribution.modelId);
    model.successfulTasks += contribution.successfulTasks * sign;
    model.failedTasks += contribution.failedTasks * sign;
    model.consumedPoints += contribution.consumedPoints * BigInt(sign);
    model.revenueMinor += contribution.revenueMinor * BigInt(sign);
    model.providerCostMinor += contribution.providerCostMinor * BigInt(sign);
    state.models.set(key, model);
  }

  if (contribution.segment !== undefined) {
    const key = dimensionKey(contribution.date, contribution.segment);
    const segment =
      state.segments.get(key) ?? emptySegment(contribution.date, contribution.segment);
    segment.acquiredUsers += contribution.acquiredUsers * sign;
    segment.activeUsers += contribution.activeUsers * sign;
    segment.retainedUsers += contribution.retainedUsers * sign;
    state.segments.set(key, segment);
  }

  if (contribution.realtimeKey !== undefined) {
    state.realtime.set(
      contribution.realtimeKey,
      (state.realtime.get(contribution.realtimeKey) ?? 0n) + BigInt(sign),
    );
  }
}

function sumDaily(metrics: Iterable<DailyMetric>): MetricTotals {
  const totals = { ...ZERO_TOTALS };
  for (const metric of metrics) {
    totals.rechargePoints += metric.rechargePoints;
    totals.rechargeAmountMinor += metric.rechargeAmountMinor;
    totals.consumedPoints += metric.consumedPoints;
    totals.revenueMinor += metric.revenueMinor;
    totals.providerCostMinor += metric.providerCostMinor;
    totals.successfulTasks += metric.successfulTasks;
    totals.failedTasks += metric.failedTasks;
  }
  return totals;
}

function totalsEqual(left: MetricTotals, right: MetricTotals): boolean {
  return Object.keys(ZERO_TOTALS).every((key) => {
    const field = key as keyof MetricTotals;
    return left[field] === right[field];
  });
}

export class InMemoryProjectionStore {
  private readonly versions = new Map<number, VersionState>([
    [
      1,
      {
        daily: new Map(),
        providers: new Map(),
        models: new Map(),
        segments: new Map(),
        realtime: new Map(),
        processed: new Map(),
        reversed: new Set(),
      },
    ],
  ]);
  private active = 1;
  private status: RebuildStatus = { status: 'IDLE', version: 1 };

  activeVersion(): number {
    return this.active;
  }

  rebuildStatus(): RebuildStatus {
    return { ...this.status };
  }

  dailyMetric(date: string, version = this.active): DailyMetric {
    const metric = this.requiredVersion(version).daily.get(date) ?? emptyDaily(date);
    return cloneDaily(metric);
  }

  allDailyMetrics(version = this.active): DailyMetric[] {
    return [...this.requiredVersion(version).daily.values()].map(cloneDaily);
  }

  providerDailyMetric(
    date: string,
    providerId: string,
    version = this.active,
  ): ProviderDailyMetric {
    const metric =
      this.requiredVersion(version).providers.get(dimensionKey(date, providerId)) ??
      emptyProvider(date, providerId);
    return { ...metric };
  }

  modelDailyMetric(date: string, modelId: string, version = this.active): ModelDailyMetric {
    const metric =
      this.requiredVersion(version).models.get(dimensionKey(date, modelId)) ??
      emptyModel(date, modelId);
    return { ...metric };
  }

  userSegmentMetric(date: string, segment: string, version = this.active): UserSegmentMetric {
    const metric =
      this.requiredVersion(version).segments.get(dimensionKey(date, segment)) ??
      emptySegment(date, segment);
    return { ...metric };
  }

  realtimeCounter(key: string, version = this.active): bigint {
    return this.requiredVersion(version).realtime.get(key) ?? 0n;
  }

  processedEventCount(version = this.active): number {
    return this.requiredVersion(version).processed.size;
  }

  checkpoint(version = this.active): ProjectionCheckpoint | undefined {
    const checkpoint = this.requiredVersion(version).checkpoint;
    return checkpoint === undefined ? undefined : { ...checkpoint };
  }

  beginRebuild(): number {
    const version = Math.max(...this.versions.keys()) + 1;
    this.versions.set(version, {
      daily: new Map(),
      providers: new Map(),
      models: new Map(),
      segments: new Map(),
      realtime: new Map(),
      processed: new Map(),
      reversed: new Set(),
    });
    this.status = { status: 'RUNNING', version };
    return version;
  }

  finishRebuild(version: number, sourceCount: number): void {
    this.requiredVersion(version);
    this.active = version;
    this.status = { status: 'SUCCEEDED', version, sourceCount };
  }

  failRebuild(version: number, reason: string): void {
    this.versions.delete(version);
    this.status = { status: 'FAILED', version, reason };
  }

  apply(
    event: EventEnvelope,
    contribution: MetricContribution | undefined,
    version = this.active,
  ): boolean {
    const current = this.requiredVersion(version);
    if (current.processed.has(event.id)) return false;
    const next = cloneVersion(current);
    if (contribution !== undefined) {
      applyContribution(next, contribution, 1);
    }
    next.processed.set(event.id, contribution);
    next.checkpoint = {
      eventId: event.id,
      projectedThrough: event.occurredAt,
      processedAt: new Date().toISOString(),
    };
    this.versions.set(version, next);
    return true;
  }

  compensate(event: EventEnvelope, reversesEventId: string, version = this.active): boolean {
    const current = this.requiredVersion(version);
    if (current.processed.has(event.id)) return false;
    const contribution = current.processed.get(reversesEventId);
    if (!current.processed.has(reversesEventId)) {
      throw new Error(`Cannot compensate unknown event ${reversesEventId}`);
    }
    const next = cloneVersion(current);
    if (contribution !== undefined && !next.reversed.has(reversesEventId)) {
      applyContribution(next, contribution, -1);
      next.reversed.add(reversesEventId);
    }
    next.processed.set(event.id, undefined);
    next.checkpoint = {
      eventId: event.id,
      projectedThrough: event.occurredAt,
      processedAt: new Date().toISOString(),
    };
    this.versions.set(version, next);
    return true;
  }

  totals(version = this.active): MetricTotals {
    return sumDaily(this.requiredVersion(version).daily.values());
  }

  private requiredVersion(version: number): VersionState {
    const state = this.versions.get(version);
    if (state === undefined) throw new Error(`Unknown projection version ${String(version)}`);
    return state;
  }
}

export class ReportingProjector {
  constructor(private readonly store: InMemoryProjectionStore) {}

  handle(event: EventEnvelope, version?: number): Promise<boolean> {
    if (event.type === 'reporting.metric-compensated.v1') {
      if (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data)) {
        throw new Error('Compensating event data must be an object');
      }
      const reversesEventId = stringField(event.data as Record<string, unknown>, 'reversesEventId');
      if (reversesEventId === undefined) throw new Error('reversesEventId is required');
      return Promise.resolve(this.store.compensate(event, reversesEventId, version));
    }
    return Promise.resolve(this.store.apply(event, contributionFor(event), version));
  }

  reconcile(
    events: EventEnvelope[],
    version = this.store.activeVersion(),
  ): {
    matches: boolean;
    projected: MetricTotals;
    source: MetricTotals;
  } {
    const sourceDaily = new Map<string, DailyMetric>();
    const contributions = new Map<string, MetricContribution>();
    const reversed = new Set<string>();
    for (const event of events) {
      if (event.type === 'reporting.metric-compensated.v1') {
        const data = event.data as Record<string, unknown>;
        const target = stringField(data, 'reversesEventId');
        if (target !== undefined && !reversed.has(target)) {
          const contribution = contributions.get(target);
          if (contribution !== undefined) {
            const metric = sourceDaily.get(contribution.date) ?? emptyDaily(contribution.date);
            addContribution(metric, contribution, -1);
            sourceDaily.set(contribution.date, metric);
            reversed.add(target);
          }
        }
        continue;
      }
      if (contributions.has(event.id)) continue;
      const contribution = contributionFor(event);
      if (contribution === undefined) continue;
      contributions.set(event.id, contribution);
      const metric = sourceDaily.get(contribution.date) ?? emptyDaily(contribution.date);
      addContribution(metric, contribution, 1);
      sourceDaily.set(contribution.date, metric);
    }
    const projected = this.store.totals(version);
    const source = sumDaily(sourceDaily.values());
    return { matches: totalsEqual(projected, source), projected, source };
  }

  async rebuild(events: EventEnvelope[]): Promise<number> {
    const version = this.store.beginRebuild();
    try {
      for (const event of events) await this.handle(event, version);
      const reconciliation = this.reconcile(events, version);
      if (!reconciliation.matches)
        throw new Error('Projection rebuild totals do not match source events');
      this.store.finishRebuild(version, events.length);
      return version;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Unknown projection rebuild failure';
      this.store.failRebuild(version, reason);
      throw error;
    }
  }
}
