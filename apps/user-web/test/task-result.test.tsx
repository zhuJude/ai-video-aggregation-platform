import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { commerceGateway } from '../lib/commerce/gateway';
import { parseAssetPage, parseSignedAssetUrl } from '../lib/commerce/runtime';
import { createUuidV7 } from '../lib/tasks/identifiers';
import { taskGateway } from '../lib/tasks/gateway';
import { parseTaskDetail } from '../lib/tasks/runtime';
import { createMockStoreTestScope } from './mock-store-scope';
import type { TaskDetail } from '../lib/tasks/types';

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: routerRefresh }),
}));
vi.mock('../components/tasks/task-status', () => ({
  TaskStatus: ({ onChange }: { readonly onChange?: (value: unknown) => void }) => (
    <button
      type="button"
      onClick={() =>
        onChange?.({
          eventId: '5:0198f4d4-21c2-7b7d-8a03-08a0da2a7555',
          revision: 5,
          status: 'SETTLED',
          terminal: true,
          cancelAllowed: false,
          updatedAt: '2026-09-13T10:05:00.000Z',
        })
      }
    >
      模拟结算
    </button>
  ),
}));

const OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7401';
const OTHER_OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7499';
const scope = createMockStoreTestScope();

beforeEach(() => {
  routerRefresh.mockClear();
  scope.install();
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_STUDIO_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = Buffer.alloc(32, 18).toString('base64url');
});

afterEach(() => {
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_STUDIO_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
  delete process.env.USER_WEB_COMMERCE_MOCK_TEST_NAMESPACE;
});

afterAll(async () => scope.cleanup());

it('publishes a successful task result only through short-lived owner-scoped signed URLs', async () => {
  const { createStudioServerGateway } = await import('../lib/studio/server-gateway');
  const gateway = createStudioServerGateway({ ownerId: OWNER_ID });
  const capability = await gateway.getSmartCapability('TEXT_TO_VIDEO');
  const parameters = {
    prompt: '云海之上掠过的列车',
    duration: 5,
    aspectRatio: '16:9',
    mockFailure: false,
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
  const accepted = await gateway.createTask(
    {
      quoteId: quote.id,
      capabilityVersion: quote.capabilityVersion,
      parameters: quote.parameters,
      quotedPoints: quote.quotedPoints,
    },
    { idempotencyKey: createUuidV7() },
  );

  const { createMockTaskEventResponse } = await import('../lib/tasks/mock-transport');
  let cursor: string | undefined;
  for (let index = 0; index < 4; index += 1) {
    const event = await createMockTaskEventResponse(OWNER_ID, accepted.taskId, cursor);
    cursor = (await event.text()).match(/^id: (.+)$/m)?.[1];
  }
  const detail = parseTaskDetail(await taskGateway.getTask(accepted.taskId, { ownerId: OWNER_ID }));
  expect(detail.result).toBeDefined();
  const resultId = detail.result?.assetId ?? '';
  const assets = parseAssetPage(
    await commerceGateway.listAssets({ kind: 'RESULT' }, { ownerId: OWNER_ID }),
  );
  expect(assets.items.some(({ id }) => id === resultId)).toBe(true);

  const preview = parseSignedAssetUrl(
    await commerceGateway.requestAssetAccess(resultId, 'PREVIEW', { ownerId: OWNER_ID }),
  );
  const download = parseSignedAssetUrl(
    await commerceGateway.requestAssetAccess(resultId, 'DOWNLOAD', { ownerId: OWNER_ID }),
  );
  expect(preview.url).not.toBe(download.url);
  expect(preview.url).not.toMatch(/storage|\.bin/i);
  expect(Date.parse(preview.expiresAt) - Date.now()).toBeLessThanOrEqual(5 * 60_000);
  await expect(
    commerceGateway.requestAssetAccess(resultId, 'PREVIEW', { ownerId: OTHER_OWNER_ID }),
  ).rejects.toThrow('ASSET_NOT_FOUND');
});

it('reveals a signed result link on demand without embedding permanent object paths', async () => {
  const { TaskResultActions } = await import('../components/tasks/task-result-actions');
  const requestAccess = vi.fn().mockResolvedValue({
    ok: true,
    url: '/api/commerce/mock-assets/signed.token',
    expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
  });
  render(<TaskResultActions taskId="task-result" requestAccess={requestAccess} />);

  fireEvent.click(screen.getByRole('button', { name: '预览结果' }));
  await waitFor(() => {
    expect(requestAccess).toHaveBeenCalledWith('task-result', 'PREVIEW');
  });
  expect(await screen.findByRole('link', { name: '打开短时预览' })).toHaveAttribute(
    'href',
    '/api/commerce/mock-assets/signed.token',
  );
  expect(document.body).not.toHaveTextContent('.bin');
});

it('refreshes the server detail when live status reaches a terminal result', async () => {
  const { TaskDetailView } = await import('../components/tasks/task-detail-view');
  const detail: TaskDetail = {
    id: 'task-live',
    taskNumber: 'T20260913-0001',
    generationMode: 'TEXT_TO_VIDEO',
    modelName: 'Story V3',
    providerName: '演示平台 West',
    createdAt: '2026-09-13T10:00:00.000Z',
    quotedPoints: '240',
    statusSnapshot: {
      eventId: '2:0198f4d4-21c2-7b7d-8a03-08a0da2a7552',
      revision: 2,
      status: 'RUNNING',
      terminal: false,
      cancelAllowed: true,
      updatedAt: '2026-09-13T10:02:00.000Z',
    },
    modelSnapshot: {
      modelId: 'mock-story-v3',
      modelName: 'Story V3',
      providerId: 'mock-provider-west',
      providerName: '演示平台 West',
      capabilityVersion: 'cap-text-v4',
      pricingVersion: 'mock-pricing-v1',
    },
    parametersSnapshot: {},
    parameterSummary: [],
    financial: {
      availablePoints: '1000',
      frozenPoints: '240',
      settledPoints: '0',
      refundedPoints: '0',
    },
    timeline: [],
  };
  const { parametersSnapshot, ...publicDetail } = detail;
  void parametersSnapshot;
  render(<TaskDetailView detail={publicDetail} />);
  fireEvent.click(screen.getByRole('button', { name: '模拟结算' }));
  expect(routerRefresh).toHaveBeenCalledTimes(1);
});
