import '@testing-library/jest-dom/vitest';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest';

import { commerceGateway } from '../lib/commerce/gateway';
import { parseAssetPage, parseSignedAssetUrl } from '../lib/commerce/runtime';
import { createUuidV7 } from '../lib/tasks/identifiers';
import { taskGateway } from '../lib/tasks/gateway';
import { parseTaskDetail } from '../lib/tasks/runtime';
import { createMockStoreTestScope } from './mock-store-scope';

const OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7401';
const OTHER_OWNER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7499';
const scope = createMockStoreTestScope();

beforeEach(() => {
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

  for (let index = 0; index < 4; index += 1) {
    await taskGateway.getTask(accepted.taskId, { ownerId: OWNER_ID });
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
