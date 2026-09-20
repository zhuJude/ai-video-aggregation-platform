import { Buffer } from 'node:buffer';

import { expect, test } from '@playwright/test';
import { IDS } from './support/platform-fixture.mjs';

const fixtureUrl = (path: string) => `https://127.0.0.1:3211${path}`;

function sessionToken(subjectId = IDS.actor) {
  return `${Buffer.from(JSON.stringify({ subjectId })).toString('base64url')}.fixture-signature`;
}

function mutationHeaders(
  identity: 'auth' | 'catalog' | 'operations-ref' | 'operations-kms',
  options: Readonly<{ actorId?: string; idempotency?: boolean }> = {},
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Correlation-Id': IDS.audit,
    'X-Trace-Id': '00112233445566778899aabbccddeeff',
  };
  if (identity === 'auth') headers['X-Service-Identity-Ref'] = 'kms://e2e/admin-auth';
  if (identity === 'catalog') headers['X-Service-Identity-Kms-Ref'] = 'kms://e2e/catalog';
  if (identity === 'operations-ref') headers['X-Service-Identity-Ref'] = 'kms://e2e/operations';
  if (identity === 'operations-kms') headers['X-Service-Identity-Kms-Ref'] = 'kms://e2e/operations';
  if (identity !== 'auth') headers['X-Admin-Session-Token'] = sessionToken(options.actorId);
  if (options.idempotency !== false) headers['Idempotency-Key'] = IDS.request;
  return headers;
}

test.beforeEach(async ({ request }) => {
  const response = await request.post(fixtureUrl('/__reset'));
  expect(response.ok()).toBe(true);
});

test('fixture rejects unsupported methods for every known endpoint', async ({ request }) => {
  const knownPaths = [
    '/__health', '/__calls', '/__reset',
    '/v1/admin-auth/password/challenges', '/v1/admin-auth/totp/verifications',
    '/v1/admin/reporting/overview', '/v1/admin/providers', `/v1/admin/providers/${IDS.provider}`,
    '/v1/admin/models', `/v1/admin/models/${IDS.model}/capabilities`, `/v1/admin/models/${IDS.model}/capabilities/commands`,
    `/v1/admin/models/${IDS.model}/capabilities/rollback-preview`,
    '/admin/pricing/current', '/admin/pricing/preview', '/admin/pricing/rollback-preview', '/admin/pricing/publish',
    '/admin/routing/current', '/admin/routing/rollback-preview', '/admin/routing/simulate', '/admin/tasks', `/admin/tasks/${IDS.task}`, `/admin/tasks/${IDS.task}/raw`,
    `/v1/admin/users/${IDS.user}/detail`, `/v1/admin/users/${IDS.user}/authorization-scope`, `/v1/admin/users/${IDS.user}/eligible-approvers`,
    `/v1/admin/users/${IDS.user}/wallet-adjustment-previews`, `/v1/admin/users/${IDS.user}/wallet-adjustment-requests`,
    `/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}`,
    `/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}/approval-previews`,
    `/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}/approvals`,
    '/admin/finance/reconciliation', `/admin/finance/reconciliation/${IDS.reconciliation}`,
    `/admin/finance/reconciliation/${IDS.reconciliation}/compensation-requests`,
    `/admin/finance/reconciliation/${IDS.reconciliation}/compensation-requests/${IDS.compensation}/approvals`,
    '/admin/finance/ledger', '/admin/finance/orders', '/admin/content', `/admin/content/${IDS.content}`,
    `/admin/content/${IDS.content}/operations`, '/admin/tickets', `/admin/tickets/${IDS.ticket}`,
    `/admin/tickets/${IDS.ticket}/transitions`, '/admin/iam',
  ];
  for (const path of knownPaths) {
    const response = await request.fetch(fixtureUrl(path), { method: 'PUT' });
    expect(response.status(), path).toBe(405);
  }
});

test('fixture rejects missing or incorrect mutation identity headers', async ({ request }) => {
  const missing = await request.post(fixtureUrl('/v1/admin-auth/password/challenges'), {
    data: { identifier: 'admin@example.com', password: 'correct horse battery staple' },
  });
  expect(missing.status()).toBe(400);

  const wrongCatalogIdentity = await request.post(fixtureUrl(`/v1/admin/models/${IDS.model}/capabilities/commands`), {
    data: { unexpected: true },
    headers: mutationHeaders('operations-kms'),
  });
  expect(wrongCatalogIdentity.status()).toBe(400);

  const wrongUserIdentity = await request.post(fixtureUrl(`/v1/admin/users/${IDS.user}/eligible-approvers`), {
    data: { scope: 'ALL' },
    headers: mutationHeaders('operations-kms', { idempotency: false }),
  });
  expect(wrongUserIdentity.status()).toBe(400);
});

test('fixture rejects malformed bodies for every known mutation without changing state', async ({ request }) => {
  await request.post(fixtureUrl('/__reset'));
  const mutations = [
    ['/v1/admin-auth/password/challenges', 'auth', true],
    ['/v1/admin-auth/totp/verifications', 'auth', true],
    ['/v1/admin/providers', 'operations-kms', true],
    [`/v1/admin/models/${IDS.model}/capabilities/commands`, 'catalog', true],
    [`/v1/admin/models/${IDS.model}/capabilities/rollback-preview`, 'catalog', false],
    ['/admin/pricing/preview', 'operations-kms', false],
    ['/admin/pricing/rollback-preview', 'operations-kms', false],
    ['/admin/pricing/publish', 'operations-kms', true],
    ['/admin/routing/rollback-preview', 'operations-kms', false],
    ['/admin/routing/simulate', 'operations-kms', false],
    [`/v1/admin/users/${IDS.user}/eligible-approvers`, 'operations-ref', false],
    [`/v1/admin/users/${IDS.user}/wallet-adjustment-previews`, 'operations-ref', true],
    [`/v1/admin/users/${IDS.user}/wallet-adjustment-requests`, 'operations-ref', true],
    [`/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}/approval-previews`, 'operations-ref', true],
    [`/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}/approvals`, 'operations-ref', true],
    [`/admin/finance/reconciliation/${IDS.reconciliation}/compensation-requests`, 'operations-kms', true],
    [`/admin/finance/reconciliation/${IDS.reconciliation}/compensation-requests/${IDS.compensation}/approvals`, 'operations-kms', true],
    [`/admin/content/${IDS.content}/operations`, 'operations-kms', true],
    [`/admin/tickets/${IDS.ticket}/transitions`, 'operations-kms', true],
  ] as const;
  for (const [path, identity, idempotency] of mutations) {
    const response = await request.post(fixtureUrl(path), {
      data: { unexpected: true },
      headers: mutationHeaders(identity, { idempotency }),
    });
    expect(response.status(), path).toBe(400);
  }
  await expect((await request.get(fixtureUrl('/__calls'))).json()).resolves.toEqual({
    calls: { compensationApprovals: 0, contentOperations: 0, iamCommands: 0, walletAdjustmentApprovals: 0 },
    state: { capabilityPublished: false, compensationApproved: false, compensationCreated: false, contentPublished: false, pricingPublished: false, ticketResolved: false, walletAdjustmentApproved: false, walletAdjustmentRequested: false },
  });
});

test('fixture reset invalidates outstanding MFA challenges', async ({ request }) => {
  const password = await request.post(fixtureUrl('/v1/admin-auth/password/challenges'), {
    data: {
      identifier: 'admin@example.com',
      password: 'correct horse battery staple',
    },
    headers: mutationHeaders('auth'),
  });
  expect(password.status()).toBe(200);
  const challenge = (await password.json()) as { challengeId: string };

  await request.post(fixtureUrl('/__reset'));

  const staleTotp = await request.post(fixtureUrl('/v1/admin-auth/totp/verifications'), {
    data: { challengeId: challenge.challengeId, code: '123456' },
    headers: mutationHeaders('auth'),
  });
  expect(staleTotp.status()).toBe(400);
});

test('fixture binds wallet approval audit identity to its header and existing request state', async ({ request }) => {
  await request.post(fixtureUrl('/__reset'));
  const response = await request.post(
    fixtureUrl(`/v1/admin/users/${IDS.user}/wallet-adjustment-requests/${IDS.request}/approvals`),
    {
      data: {
        audit: { idempotencyKey: IDS.audit },
        expectedVersion: 1,
        preflightToken: 'approval-token-abcdefghijklmnopqrstuvwxyz',
        reason: '独立复核活动补偿',
      },
      headers: mutationHeaders('operations-ref', { actorId: IDS.reviewer }),
    },
  );
  expect(response.status()).toBe(400);
  const after = await request.get(fixtureUrl('/__calls'));
  await expect(after.json()).resolves.toMatchObject({
    calls: { walletAdjustmentApprovals: 0 },
    state: { walletAdjustmentApproved: false, walletAdjustmentRequested: false },
  });
});
