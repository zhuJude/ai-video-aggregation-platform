import { describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@repo/contracts/common';
import { InMemoryProjectionStore, ReportingProjector } from '../src/application/projector.js';

const correlationId = '01991f17-2166-7000-8000-000000000001';
const providerId = '01991f17-2166-7000-8000-000000000002';
const modelId = '01991f17-2166-7000-8000-000000000003';

function event(id: string, type: string, data: Record<string, unknown>): EventEnvelope {
  return {
    id,
    type,
    version: 1,
    occurredAt: '2026-08-28T02:00:00.000Z',
    traceId: 'a'.repeat(32),
    correlationId,
    producer: 'test',
    data,
  };
}

const paymentPaid = event('01991f17-2166-7000-8000-000000000010', 'payment.recharge-paid.v1', {
  rechargePoints: '10000',
  rechargeAmountMinor: '10000',
});
const taskSettled = event('01991f17-2166-7000-8000-000000000011', 'generation.task-settled.v1', {
  consumedPoints: '1200',
  revenueMinor: '1200',
  providerCostMinor: '700',
  providerId,
  modelId,
  durationMs: 45_000,
});

describe('ReportingProjector', () => {
  it('does not double count a replayed payment and task event', async () => {
    const store = new InMemoryProjectionStore();
    const projector = new ReportingProjector(store);

    await projector.handle(paymentPaid);
    await projector.handle(paymentPaid);
    await projector.handle(taskSettled);
    await projector.handle(taskSettled);

    expect(store.dailyMetric('2026-08-28')).toMatchObject({
      rechargePoints: 10_000n,
      rechargeAmountMinor: 10_000n,
      consumedPoints: 1_200n,
      revenueMinor: 1_200n,
      providerCostMinor: 700n,
      marginNumeratorMinor: 500n,
      marginDenominatorMinor: 1_200n,
      successfulTasks: 1,
    });
    expect(store.processedEventCount()).toBe(2);
  });

  it('subtracts a prior contribution exactly once through a compensating event', async () => {
    const store = new InMemoryProjectionStore();
    const projector = new ReportingProjector(store);
    const compensation = event(
      '01991f17-2166-7000-8000-000000000012',
      'reporting.metric-compensated.v1',
      { reversesEventId: taskSettled.id },
    );

    await projector.handle(taskSettled);
    await projector.handle(compensation);
    await projector.handle(compensation);

    expect(store.dailyMetric('2026-08-28')).toMatchObject({
      consumedPoints: 0n,
      providerCostMinor: 0n,
      successfulTasks: 0,
    });
  });

  it('reconciles active finance and task totals to retained source events', async () => {
    const store = new InMemoryProjectionStore();
    const projector = new ReportingProjector(store);
    await projector.handle(paymentPaid);
    await projector.handle(taskSettled);

    expect(projector.reconcile([paymentPaid, taskSettled])).toEqual({
      matches: true,
      projected: {
        rechargePoints: 10_000n,
        rechargeAmountMinor: 10_000n,
        consumedPoints: 1_200n,
        revenueMinor: 1_200n,
        providerCostMinor: 700n,
        successfulTasks: 1,
        failedTasks: 0,
      },
      source: {
        rechargePoints: 10_000n,
        rechargeAmountMinor: 10_000n,
        consumedPoints: 1_200n,
        revenueMinor: 1_200n,
        providerCostMinor: 700n,
        successfulTasks: 1,
        failedTasks: 0,
      },
    });
  });

  it('updates provider, model and freshness read models in the same event effect', async () => {
    const store = new InMemoryProjectionStore();
    const projector = new ReportingProjector(store);

    await projector.handle(taskSettled);

    expect(store.providerDailyMetric('2026-08-28', providerId)).toMatchObject({
      successfulTasks: 1,
      failedTasks: 0,
      providerCostMinor: 700n,
      durationMsTotal: 45_000n,
      durationSamples: 1,
    });
    expect(store.modelDailyMetric('2026-08-28', modelId)).toMatchObject({
      successfulTasks: 1,
      consumedPoints: 1_200n,
      revenueMinor: 1_200n,
      providerCostMinor: 700n,
    });
    expect(store.checkpoint()).toMatchObject({
      eventId: taskSettled.id,
      projectedThrough: taskSettled.occurredAt,
    });
  });

  it('projects acquisition, activity, retention and bounded realtime counters', async () => {
    const store = new InMemoryProjectionStore();
    const projector = new ReportingProjector(store);
    const registered = event(
      '01991f17-2166-7000-8000-000000000020',
      'identity.user-registered.v1',
      { segment: 'organic' },
    );
    const active = event('01991f17-2166-7000-8000-000000000021', 'identity.user-active.v1', {
      segment: 'organic',
      retained: true,
    });

    await projector.handle(registered);
    await projector.handle(active);

    expect(store.userSegmentMetric('2026-08-28', 'organic')).toMatchObject({
      acquiredUsers: 1,
      activeUsers: 1,
      retainedUsers: 1,
    });
    expect(store.realtimeCounter('users_registered')).toBe(1n);
    expect(store.realtimeCounter('users_active')).toBe(1n);
  });

  it('rebuilds into a validated shadow version before switching active reads', async () => {
    const store = new InMemoryProjectionStore();
    const projector = new ReportingProjector(store);
    await projector.handle(paymentPaid);

    const rebuiltVersion = await projector.rebuild([paymentPaid, taskSettled]);

    expect(rebuiltVersion).toBe(2);
    expect(store.activeVersion()).toBe(2);
    expect(store.dailyMetric('2026-08-28')).toMatchObject({
      rechargePoints: 10_000n,
      consumedPoints: 1_200n,
      successfulTasks: 1,
    });
    expect(store.rebuildStatus()).toMatchObject({ status: 'SUCCEEDED', version: 2 });
  });
});
