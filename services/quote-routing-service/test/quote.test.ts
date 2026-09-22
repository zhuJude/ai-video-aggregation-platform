import { describe, expect, it } from 'vitest';
import {
  InMemoryQuoteRepository,
  QuoteService,
  canonicalParametersHash,
  type QuoteRequest,
} from '../src/application/quote.service.js';

const now = new Date('2026-08-31T00:00:00.000Z');
const modelA = '01999d31-f7a3-7c50-98ae-04a08e875501';
const modelB = '01999d31-f7a3-7c50-98ae-04a08e875502';

function input(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    userId: '01999d31-f7a3-7c50-98ae-04a08e875503',
    mode: 'SMART',
    capabilityVersionId: '01999d31-f7a3-7c50-98ae-04a08e875504',
    parameters: { prompt: 'ocean', duration: 5, nested: { b: 2, a: 1 } },
    candidates: [
      {
        modelId: modelA,
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
      },
      {
        modelId: modelB,
        capabilityMatch: true,
        status: 'ACTIVE',
        inMaintenance: false,
        circuitOpen: false,
        quotaExhausted: false,
        providerBalanceLow: false,
        health: 'HEALTHY',
        costPoints: 50n,
        salePoints: 90n,
        qualityBasisPoints: 8500,
        latencyMs: 400,
        priority: 5,
      },
    ],
    weights: { quality: 40, speed: 30, price: 30, minimumMarginBps: 2000 },
    pricingRuleVersion: 3,
    routingRuleVersion: 2,
    ...overrides,
  };
}

describe('quote service', () => {
  it('rejects a changed parameter set and an expired quote', async () => {
    const service = new QuoteService(new InMemoryQuoteRepository(), () => 'quote-1');
    const request = input();
    const quote = await service.create(request, now);

    await expect(
      service.assertUsable(quote.id, { ...request.parameters, duration: 10 }, now),
    ).rejects.toMatchObject({ code: 'QUOTE_PARAMETERS_CHANGED' });
    await expect(
      service.assertUsable(quote.id, request.parameters, new Date(now.getTime() + 600_001)),
    ).rejects.toMatchObject({ code: 'QUOTE_EXPIRED' });
  });

  it('hashes recursively sorted objects while preserving array order', () => {
    expect(canonicalParametersHash({ b: 2, a: { d: 4, c: 3 }, list: [2, 1] })).toBe(
      canonicalParametersHash({ list: [2, 1], a: { c: 3, d: 4 }, b: 2 }),
    );
    expect(canonicalParametersHash({ list: [1, 2] })).not.toBe(
      canonicalParametersHash({ list: [2, 1] }),
    );
  });

  it('creates deterministic financial and routing snapshots for the same input', async () => {
    const repository = new InMemoryQuoteRepository();
    const ids = ['quote-1', 'quote-2'];
    const service = new QuoteService(repository, () => ids.shift() ?? 'unexpected');

    const first = await service.create(input(), now);
    const second = await service.create(input(), now);

    expect({ ...second, id: first.id }).toEqual(first);
  });

  it('professional mode selects exactly the requested model and defaults failover to false', async () => {
    const service = new QuoteService(new InMemoryQuoteRepository(), () => 'quote-pro');

    const quote = await service.create(
      input({ mode: 'PROFESSIONAL', requestedModelId: modelA }),
      now,
    );

    expect(quote.modelId).toBe(modelA);
    expect(quote.candidateModelIds).toEqual([modelA]);
    expect(quote.allowFailover).toBe(false);
  });

  it('professional mode records failover only when explicitly requested', async () => {
    const service = new QuoteService(new InMemoryQuoteRepository(), () => 'quote-pro');

    const quote = await service.create(
      input({ mode: 'PROFESSIONAL', requestedModelId: modelA, allowFailover: true }),
      now,
    );

    expect(quote.allowFailover).toBe(true);
  });

  it('route simulation returns the same decision without persisting a quote', () => {
    const repository = new InMemoryQuoteRepository();
    const service = new QuoteService(repository, () => 'quote-1');

    const decision = service.simulate(input());

    expect(decision.selected.modelId).toBe(modelB);
    expect(repository.size).toBe(0);
  });
});
