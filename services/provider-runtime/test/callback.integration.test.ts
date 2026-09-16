/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/unbound-method */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { ProviderCallbackError } from '../src/index.js';
import {
  ProviderCallbackController,
  ProviderCallbackService,
  callbackDeduplicationKey,
  decideProviderUpdate,
  type ApplyCallbackInput,
  type CallbackRepository,
  type ProviderCallbackAdapter,
} from '../src/index.js';

const PROVIDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a51a7';
const RAW = new TextEncoder().encode('{"opaque":"signed-provider-body"}');

class CallbackRepo implements CallbackRepository {
  readonly applied: ApplyCallbackInput[] = [];
  result: Awaited<ReturnType<CallbackRepository['apply']>> = { kind: 'APPLIED' };

  async apply(input: ApplyCallbackInput) {
    this.applied.push(input);
    return this.result;
  }
}

function harness(valid = true) {
  const repository = new CallbackRepo();
  const order: string[] = [];
  const adapter: ProviderCallbackAdapter = {
    verifyCallback: vi.fn(async ({ body }) => {
      order.push('verify');
      expect(body).toBe(RAW);
      return { valid, payload: { opaque: true } };
    }),
    normalizeCallback: vi.fn(async () => {
      order.push('normalize');
      return {
        providerEventId: 'evt-3',
        providerTaskId: 'remote-1',
        sequence: 3,
        state: 'SUCCEEDED',
        resultUrls: ['https://mock.invalid/result.mp4'],
      };
    }),
  };
  let id = 0;
  const service = new ProviderCallbackService({
    adapters: { resolve: vi.fn().mockResolvedValue(adapter) },
    repository,
    clock: { now: () => new Date('2026-08-31T12:00:00.000Z') },
    ids: { next: () => `0198f4d4-21c2-7b7d-8a03-08a0da2a5${String(++id).padStart(3, '0')}` },
  });
  return {
    adapter,
    controller: new ProviderCallbackController(service),
    order,
    repository,
    service,
  };
}

describe('provider callback ingress', () => {
  it('verifies the exact raw bytes before normalizing or persisting', async () => {
    const { controller, order, repository } = harness();
    await expect(
      controller.post(PROVIDER_ID, { 'x-provider-signature': 'opaque' }, RAW),
    ).resolves.toEqual({ statusCode: 202, body: { outcome: 'APPLIED' } });
    expect(order).toEqual(['verify', 'normalize']);
    expect(repository.applied[0]).toMatchObject({
      providerId: PROVIDER_ID,
      providerEventId: 'evt-3',
      providerTaskId: 'remote-1',
      sequence: 3,
      state: 'SUCCEEDED',
      payloadSha256: createHash('sha256').update(RAW).digest('hex'),
    });
  });

  it('never parses or normalizes a callback whose signature is invalid', async () => {
    const { adapter, repository, service } = harness(false);
    await expect(
      service.handle({ providerId: PROVIDER_ID, headers: {}, rawBody: RAW }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ProviderCallbackError>>({
        code: 'INVALID_CALLBACK_SIGNATURE',
        statusCode: 401,
      }),
    );
    expect(vi.mocked(adapter.normalizeCallback)).not.toHaveBeenCalled();
    expect(repository.applied).toHaveLength(0);
  });

  it('rejects a malformed provider route before adapter resolution side effects', async () => {
    const { repository, service } = harness();
    await expect(
      service.handle({ providerId: 'not-a-uuid', headers: {}, rawBody: RAW }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_ID', statusCode: 400 });
    expect(repository.applied).toHaveLength(0);
  });

  it.each(['DUPLICATE', 'OUT_OF_ORDER', 'TERMINAL_IGNORED'] as const)(
    'acknowledges %s callbacks without asking the provider to retry',
    async (kind) => {
      const { controller, repository } = harness();
      repository.result = { kind };
      await expect(controller.post(PROVIDER_ID, {}, RAW)).resolves.toEqual({
        statusCode: 202,
        body: { outcome: kind },
      });
    },
  );
});

describe('provider state monotonicity', () => {
  it('applies the highest sequence once and ignores duplicates and older callbacks', () => {
    expect(decideProviderUpdate({ status: 'RUNNING', lastSequence: 2 }, 'SUCCEEDED', 3)).toBe(
      'APPLY',
    );
    expect(decideProviderUpdate({ status: 'SUCCEEDED', lastSequence: 3 }, 'SUCCEEDED', 3)).toBe(
      'OUT_OF_ORDER',
    );
    expect(decideProviderUpdate({ status: 'SUCCEEDED', lastSequence: 3 }, 'RUNNING', 2)).toBe(
      'OUT_OF_ORDER',
    );
  });

  it('never regresses state and never changes a terminal outcome', () => {
    expect(decideProviderUpdate({ status: 'RUNNING', lastSequence: 2 }, 'ACCEPTED', 3)).toBe(
      'STATE_REGRESSION',
    );
    expect(decideProviderUpdate({ status: 'SUCCEEDED', lastSequence: 3 }, 'FAILED', 4)).toBe(
      'TERMINAL_IGNORED',
    );
    expect(decideProviderUpdate({ status: 'FAILED', lastSequence: 3 }, 'SUCCEEDED', 4)).toBe(
      'TERMINAL_IGNORED',
    );
  });
});

it('bounds callback outbox deduplication keys even for maximum provider event IDs', () => {
  const key = callbackDeduplicationKey('0198f4d4-21c2-7b7d-8a03-08a0da2a51b0', 'x'.repeat(256));
  expect(key.length).toBeLessThanOrEqual(240);
  expect(key).toBe(
    callbackDeduplicationKey('0198f4d4-21c2-7b7d-8a03-08a0da2a51b0', 'x'.repeat(256)),
  );
});
