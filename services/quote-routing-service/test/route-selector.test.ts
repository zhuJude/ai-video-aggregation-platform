import { describe, expect, it } from 'vitest';
import {
  selectRoute,
  type RouteCandidate,
  type RouteWeights,
} from '../src/domain/route-selector.js';

const weights: RouteWeights = {
  quality: 40,
  speed: 30,
  price: 30,
  minimumMarginBps: 2000,
};

function candidate(overrides: Partial<RouteCandidate> = {}): RouteCandidate {
  return {
    modelId: 'model-a',
    capabilityMatch: true,
    status: 'ACTIVE',
    inMaintenance: false,
    circuitOpen: false,
    quotaExhausted: false,
    providerBalanceLow: false,
    health: 'HEALTHY',
    costPoints: 60n,
    salePoints: 100n,
    qualityBasisPoints: 8000,
    latencyMs: 500,
    priority: 10,
    ...overrides,
  };
}

describe('deterministic route selector', () => {
  it('filters unhealthy and below-margin candidates before scoring', () => {
    const result = selectRoute(
      [
        candidate({ modelId: 'down', health: 'UNHEALTHY' }),
        candidate({ modelId: 'loss', costPoints: 99n, salePoints: 100n }),
        candidate({ modelId: 'healthy-profitable' }),
      ],
      weights,
    );

    expect(result.selected.modelId).toBe('healthy-profitable');
    expect(result.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ modelId: 'down', reason: 'UNHEALTHY' }),
        expect.objectContaining({ modelId: 'loss', reason: 'MARGIN_BELOW_MINIMUM' }),
      ]),
    );
  });

  it('uses model id as stable final tie breaker', () => {
    const result = selectRoute(
      [candidate({ modelId: 'model-b' }), candidate({ modelId: 'model-a' })],
      weights,
    );

    expect(result.selected.modelId).toBe('model-a');
  });

  it('uses configured priority before model id for equal scores', () => {
    const result = selectRoute(
      [
        candidate({ modelId: 'model-a', priority: 20 }),
        candidate({ modelId: 'model-z', priority: 1 }),
      ],
      weights,
    );

    expect(result.selected.modelId).toBe('model-z');
  });

  it('is deterministic when candidate input order changes', () => {
    const candidates = [
      candidate({ modelId: 'quality', qualityBasisPoints: 9500, latencyMs: 800 }),
      candidate({ modelId: 'speed', qualityBasisPoints: 8000, latencyMs: 200 }),
      candidate({ modelId: 'price', salePoints: 80n, costPoints: 40n }),
    ];

    const forward = selectRoute(candidates, weights);
    const reversed = selectRoute([...candidates].reverse(), weights);

    expect(reversed).toEqual(forward);
  });

  it.each([
    ['CAPABILITY_MISMATCH', { capabilityMatch: false }],
    ['MODEL_NOT_ACTIVE', { status: 'DISABLED' as const }],
    ['MAINTENANCE', { inMaintenance: true }],
    ['CIRCUIT_OPEN', { circuitOpen: true }],
    ['QUOTA_EXHAUSTED', { quotaExhausted: true }],
    ['PROVIDER_BALANCE_LOW', { providerBalanceLow: true }],
  ])('records the %s exclusion reason', (reason, overrides) => {
    const result = selectRoute(
      [candidate({ modelId: 'excluded', ...overrides }), candidate({ modelId: 'selected' })],
      weights,
    );

    expect(result.excluded).toContainEqual({ modelId: 'excluded', reason });
  });

  it('returns integer normalized score components and margin', () => {
    const result = selectRoute(
      [
        candidate({ modelId: 'slow-expensive', latencyMs: 1000, salePoints: 120n }),
        candidate({ modelId: 'fast-cheap', latencyMs: 100, salePoints: 80n }),
      ],
      weights,
    );

    for (const scored of result.scored) {
      expect(Number.isInteger(scored.totalScore)).toBe(true);
      expect(Number.isInteger(scored.components.quality)).toBe(true);
      expect(Number.isInteger(scored.components.speed)).toBe(true);
      expect(Number.isInteger(scored.components.price)).toBe(true);
      expect(Number.isInteger(scored.marginBasisPoints)).toBe(true);
    }
  });

  it('fails explicitly when no candidate is eligible', () => {
    expect(() =>
      selectRoute([candidate({ health: 'UNHEALTHY' })], weights),
    ).toThrow('NO_ELIGIBLE_ROUTE');
  });
});
