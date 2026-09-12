import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeMockSubject,
  rebindMockSubjectPhone,
  resolveExistingMockSubjectForVerifiedPhone,
  resolveOrCreateMockSubjectForVerifiedPhone,
} from '../lib/auth/mock-subject-store';
import { commerceGateway } from '../lib/commerce/gateway';
import { safeReturnTo } from '../lib/auth/safe-return-to';
import { parseAssetPage, parseOrderPage, parseWalletPage } from '../lib/commerce/runtime';
import { supportGateway } from '../lib/support/gateway';
import { parseMessagePage, parseTicketPage } from '../lib/support/runtime';
import { taskGateway } from '../lib/tasks/gateway';
import { parseTaskPage } from '../lib/tasks/runtime';
import { createMockStoreTestScope } from './mock-store-scope';

const OLD_PHONE = '+8613800138000';
const NEW_PHONE = '+8613900139000';
const mockStoreScope = createMockStoreTestScope();

beforeEach(() => {
  mockStoreScope.install();
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_SUPPORT_MODE = 'mock';
  process.env.USER_WEB_STUDIO_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = Buffer.alloc(32, 17).toString('base64url');
  process.env.USER_WEB_COMMERCE_IDENTITY_KEY = randomBytes(32).toString('base64url');
  process.env.USER_WEB_MOCK_IDENTITY_KEY = randomBytes(32).toString('base64url');
});

afterEach(() => {
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_SUPPORT_MODE;
  delete process.env.USER_WEB_STUDIO_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
  delete process.env.USER_WEB_COMMERCE_IDENTITY_KEY;
  delete process.env.USER_WEB_MOCK_IDENTITY_KEY;
  delete process.env.USER_WEB_COMMERCE_MOCK_TEST_NAMESPACE;
});

afterAll(async () => {
  await mockStoreScope.cleanup();
});

describe('stable mock subject ownership', () => {
  it('fails closed when the independent mock identity key is unavailable', async () => {
    const identityKey = process.env.USER_WEB_MOCK_IDENTITY_KEY;
    try {
      delete process.env.USER_WEB_MOCK_IDENTITY_KEY;
      await expect(resolveExistingMockSubjectForVerifiedPhone(OLD_PHONE)).rejects.toThrow(
        'MOCK_IDENTITY_KEY_UNAVAILABLE',
      );
    } finally {
      if (identityKey) process.env.USER_WEB_MOCK_IDENTITY_KEY = identityKey;
    }
  });

  it('allows only protected app-relative refresh destinations', () => {
    for (const path of [
      '/studio',
      '/tasks/task-1?status=RUNNING',
      '/assets',
      '/wallet',
      '/orders',
      '/invoices',
      '/messages',
      '/tickets',
      '/settings/profile',
      '/settings/security',
    ]) {
      expect(safeReturnTo(path)).toBe(path);
    }
    for (const path of [
      '//evil.example',
      'https://evil.example/tasks',
      '/tasks\\evil',
      '/tasks#token',
      '/tasks/../wallet',
      '/tasks/%2e%2e/wallet',
      '/unknown',
    ]) {
      expect(safeReturnTo(path)).toBe('/tasks');
    }
  });

  it('keeps one stable subject across phone change and does not remap the old phone', async () => {
    const subjectId = await resolveOrCreateMockSubjectForVerifiedPhone(OLD_PHONE);
    await rebindMockSubjectPhone(subjectId, OLD_PHONE, NEW_PHONE);

    await expect(resolveExistingMockSubjectForVerifiedPhone(NEW_PHONE)).resolves.toBe(subjectId);
    await expect(resolveExistingMockSubjectForVerifiedPhone(OLD_PHONE)).resolves.toBeUndefined();
    await expect(resolveOrCreateMockSubjectForVerifiedPhone(OLD_PHONE)).resolves.not.toBe(
      subjectId,
    );
  });

  it('preserves task, commerce, message and ticket ownership after rebind', async () => {
    const subjectId = await resolveOrCreateMockSubjectForVerifiedPhone(OLD_PHONE);
    const before = {
      tasks: parseTaskPage(await taskGateway.listTasks({}, { ownerId: subjectId })),
      assets: parseAssetPage(await commerceGateway.listAssets({}, { ownerId: subjectId })),
      wallet: parseWalletPage(await commerceGateway.getWallet({}, { ownerId: subjectId })),
      orders: parseOrderPage(await commerceGateway.listOrders({}, { ownerId: subjectId })),
      messages: parseMessagePage(await supportGateway.listMessages({}, { ownerId: subjectId })),
      tickets: parseTicketPage(await supportGateway.listTickets({}, { ownerId: subjectId })),
    };
    expect(before.tasks.items.length).toBeGreaterThan(0);
    expect(before.assets.items.length).toBeGreaterThan(0);
    expect(before.orders.items.length).toBeGreaterThan(0);
    expect(before.messages.items.length).toBeGreaterThan(0);
    expect(before.tickets.items.length).toBeGreaterThan(0);

    await rebindMockSubjectPhone(subjectId, OLD_PHONE, NEW_PHONE);
    const rebound = await resolveExistingMockSubjectForVerifiedPhone(NEW_PHONE);
    expect(rebound).toBe(subjectId);
    await expect(taskGateway.listTasks({}, { ownerId: rebound ?? '' })).resolves.toEqual(
      before.tasks,
    );
    await expect(commerceGateway.listAssets({}, { ownerId: rebound ?? '' })).resolves.toEqual(
      before.assets,
    );
    await expect(commerceGateway.getWallet({}, { ownerId: rebound ?? '' })).resolves.toEqual(
      before.wallet,
    );
    await expect(commerceGateway.listOrders({}, { ownerId: rebound ?? '' })).resolves.toEqual(
      before.orders,
    );
    await expect(supportGateway.listMessages({}, { ownerId: rebound ?? '' })).resolves.toEqual(
      before.messages,
    );
    await expect(supportGateway.listTickets({}, { ownerId: rebound ?? '' })).resolves.toEqual(
      before.tickets,
    );
  });

  it('keeps another user isolated and closes a deleted subject fail-closed', async () => {
    const first = await resolveOrCreateMockSubjectForVerifiedPhone(OLD_PHONE);
    const other = await resolveOrCreateMockSubjectForVerifiedPhone('+8613700137000');
    expect(other).not.toBe(first);
    await expect(taskGateway.getTask('task-1', { ownerId: other })).rejects.toThrow(
      'TASK_NOT_FOUND',
    );

    await closeMockSubject(first, OLD_PHONE);
    await expect(resolveExistingMockSubjectForVerifiedPhone(OLD_PHONE)).resolves.toBeUndefined();
    await expect(resolveOrCreateMockSubjectForVerifiedPhone(OLD_PHONE)).rejects.toThrow(
      'ACCOUNT_CLOSED',
    );
  });
});
