import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { commerceGateway } from '../lib/commerce/gateway';
import { parseWalletPage } from '../lib/commerce/runtime';
import { createUuidV7 } from '../lib/tasks/identifiers';
import { taskGateway } from '../lib/tasks/gateway';
import { parseTaskDetail, parseTaskPage } from '../lib/tasks/runtime';
import { createMockStoreTestScope } from './mock-store-scope';

const OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7401';
const OTHER_OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7499';
const scope = createMockStoreTestScope();

beforeEach(() => {
  scope.install();
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_STUDIO_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = Buffer.alloc(32, 17).toString('base64url');
});

afterEach(() => {
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_STUDIO_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
  delete process.env.USER_WEB_COMMERCE_MOCK_TEST_NAMESPACE;
});

afterAll(async () => {
  await scope.cleanup();
});

async function gatewayFor(ownerId: string) {
  const module = await import('../lib/studio/server-gateway');
  return module.createStudioServerGateway({ ownerId });
}

async function createTask(options: { readonly fail?: boolean; readonly key?: string } = {}) {
  const gateway = await gatewayFor(OWNER_ID);
  const capability = await gateway.getSmartCapability('TEXT_TO_VIDEO');
  const parameters = {
    prompt: '日落下的海边公路，镜头缓慢向前',
    duration: 5,
    aspectRatio: '16:9',
    mockFailure: options.fail ?? false,
  };
  const quote = await gateway.quote({
    routing: {
      kind: 'SMART',
      preferences: {
        generationMode: 'TEXT_TO_VIDEO',
        quality: 'BALANCED',
        speed: 'BALANCED',
        budgetPoints: 500,
        goal: '',
      },
    },
    capabilityVersion: capability.capabilityVersion,
    parameters,
  });
  const key = options.key ?? createUuidV7();
  const request = {
    quoteId: quote.id,
    capabilityVersion: quote.capabilityVersion,
    parameters: quote.parameters,
    quotedPoints: quote.quotedPoints,
  };
  return { gateway, key, request, quote };
}

describe('mock commercial journey', () => {
  it('fails closed when the Studio mock is not explicitly enabled', async () => {
    delete process.env.USER_WEB_STUDIO_MODE;
    const gateway = await gatewayFor(OWNER_ID);
    await expect(gateway.listProviders()).rejects.toThrow('STUDIO_GATEWAY_UNAVAILABLE');
  });

  it('creates exactly one reserved task for an idempotent submission and persists it', async () => {
    const before = parseWalletPage(await commerceGateway.getWallet({}, { ownerId: OWNER_ID }));
    const setup = await createTask();
    const [first, replay] = await Promise.all([
      setup.gateway.createTask(setup.request, { idempotencyKey: setup.key }),
      setup.gateway.createTask(setup.request, { idempotencyKey: setup.key }),
    ]);

    expect(replay).toEqual(first);
    const listed = parseTaskPage(await taskGateway.listTasks({}, { ownerId: OWNER_ID }));
    expect(listed.items.filter(({ id }) => id === first.taskId)).toHaveLength(1);
    const wallet = parseWalletPage(await commerceGateway.getWallet({}, { ownerId: OWNER_ID }));
    const entries = wallet.transactions.filter(
      ({ type, reference }) => type === 'RESERVE' && reference?.id === first.taskId,
    );
    expect(entries).toHaveLength(1);
    expect(BigInt(wallet.balance.available) + BigInt(wallet.balance.frozen)).toBe(
      BigInt(before.balance.available) + BigInt(before.balance.frozen),
    );

    vi.resetModules();
    const isolated = await import('../lib/studio/server-gateway');
    const reloaded = isolated.createStudioServerGateway({ ownerId: OWNER_ID });
    await expect(
      reloaded.createTask(setup.request, { idempotencyKey: setup.key }),
    ).resolves.toEqual(first);
    await expect(taskGateway.getTask(first.taskId, { ownerId: OTHER_OWNER_ID })).rejects.toThrow(
      'TASK_NOT_FOUND',
    );
    await expect(
      setup.gateway.createTask(
        { ...setup.request, quotedPoints: (BigInt(setup.request.quotedPoints) + 1n).toString() },
        { idempotencyKey: setup.key },
      ),
    ).rejects.toThrow('IDEMPOTENCY_CONFLICT');
  });

  it('settles a successful task once despite duplicate reads and conserves wallet points', async () => {
    const setup = await createTask();
    const accepted = await setup.gateway.createTask(setup.request, { idempotencyKey: setup.key });
    const statuses: string[] = ['QUEUED'];
    for (let index = 0; index < 5; index += 1) {
      statuses.push(
        parseTaskDetail(await taskGateway.getTask(accepted.taskId, { ownerId: OWNER_ID }))
          .statusSnapshot.status,
      );
    }
    expect(statuses).toEqual([
      'QUEUED',
      'SUBMITTING',
      'RUNNING',
      'SUCCEEDED',
      'SETTLED',
      'SETTLED',
    ]);

    const wallet = parseWalletPage(await commerceGateway.getWallet({}, { ownerId: OWNER_ID }));
    expect(
      wallet.transactions.filter(
        ({ type, reference }) => type === 'SETTLE' && reference?.id === accepted.taskId,
      ),
    ).toHaveLength(1);
    expect(
      BigInt(wallet.balance.available) +
        BigInt(wallet.balance.frozen) +
        BigInt(wallet.balance.totalConsumed),
    ).toBe(BigInt(wallet.balance.totalRecharged));
  });

  it('releases a failed task once despite duplicate reads and refunds the reservation', async () => {
    const before = parseWalletPage(await commerceGateway.getWallet({}, { ownerId: OWNER_ID }));
    const setup = await createTask({ fail: true });
    const accepted = await setup.gateway.createTask(setup.request, { idempotencyKey: setup.key });
    const statuses: string[] = ['QUEUED'];
    for (let index = 0; index < 5; index += 1) {
      statuses.push(
        parseTaskDetail(await taskGateway.getTask(accepted.taskId, { ownerId: OWNER_ID }))
          .statusSnapshot.status,
      );
    }
    expect(statuses).toEqual(['QUEUED', 'SUBMITTING', 'RUNNING', 'FAILED', 'REFUNDED', 'REFUNDED']);
    const after = parseWalletPage(await commerceGateway.getWallet({}, { ownerId: OWNER_ID }));
    expect(after.balance.available).toBe(before.balance.available);
    expect(
      after.transactions.filter(
        ({ type, reference }) => type === 'RELEASE' && reference?.id === accepted.taskId,
      ),
    ).toHaveLength(1);
  });

  it('emits reconnectable SSE status events from the same authoritative task state', async () => {
    const setup = await createTask();
    const accepted = await setup.gateway.createTask(setup.request, { idempotencyKey: setup.key });
    const { createMockTaskEventResponse } = await import('../lib/tasks/mock-transport');

    const response = await createMockTaskEventResponse(OWNER_ID, accepted.taskId);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const payload = await response.text();
    expect(payload).toMatch(/^id: 2:[0-9a-f-]+\nevent: task\.status\ndata: /);
    expect(payload).toContain('"status":"SUBMITTING"');
    expect(payload).not.toContain('parametersSnapshot');
    await expect(
      createMockTaskEventResponse(OWNER_ID, accepted.taskId, 'forged-cursor'),
    ).rejects.toThrow('INVALID_TASK_CURSOR');
  });
});
