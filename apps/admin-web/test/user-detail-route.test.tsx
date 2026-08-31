/* eslint-disable @typescript-eslint/require-await -- route dependencies are async ports. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderUserDetailRoute } from '../app/(secure)/users/[id]/page';
import { UserDetailPortError, type UserDetailPort, type UserDetailView } from '../lib/user-detail-view-loader';
import { signAdminSession } from '../lib/session-auth';
import { createHttpUserOperationPorts } from '../lib/http-user-operation-port';

const signingKey = 'user-detail-route-signing-key-at-least-32-bytes';
const userId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';

const view: UserDetailView = {
  canRequestWalletAdjustment: false,
  deniedTabs: ['tasks', 'wallet', 'orders', 'tickets', 'audit'],
  tabs: [{ account: { createdAt: '2026-08-30T10:00:00.000Z', displayName: '路由用户', phoneMasked: '138****8000', registrationSource: 'WEB', status: 'ACTIVE', spendingTier: 'HIGH', tags: ['vip'] }, id: 'account', session: { devices: [], lastActiveAt: '2026-08-31T08:00:00.000Z', loginRecords: [], status: 'ACTIVE' }, status: 'READY' }],
  user: { displayName: '路由用户', id: userId, phoneMasked: '138****8000', status: 'ACTIVE' },
};

function authoritativePayload() {
  return {
    allowedStatusTransitions: ['SUSPENDED'], canRequestWalletAdjustment: false, deniedTabs: [], eligibleApprovers: [],
    tabs: [
      { account: { createdAt: '2026-08-30T10:00:00.000Z', displayName: '路由用户', phoneMasked: '138****8000', registrationSource: 'WEB', status: 'ACTIVE', spendingTier: 'HIGH', tags: [{ value: 'vip' }] }, id: 'account', session: { devices: [{ id: '0198f7a4-c6e0-7b39-8a4e-73af0c1d2e3f', lastSeenAt: '2026-08-31T08:00:00.000Z', platform: 'iOS', status: 'ACTIVE' }], lastActiveAt: '2026-08-31T08:00:00.000Z', loginRecords: [{ deviceLabel: 'iPhone', id: '0198f7a4-c6e1-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', status: 'SUCCESS' }], status: 'ACTIVE' }, status: 'READY' },
      { id: 'tasks', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e2-7b39-8a4e-73af0c1d2e3f', status: 'SUCCEEDED' }], status: 'READY' },
      { adjustmentHistory: [{ direction: 'CREDIT', id: '0198f7a4-c6e5-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '5', status: 'APPROVED' }], balance: '100', consumptionHistory: [{ direction: 'DEBIT', id: '0198f7a4-c6e4-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '10', status: 'SETTLED' }], frozenBalance: '20', id: 'wallet', rechargeHistory: [{ direction: 'CREDIT', id: '0198f7a4-c6e3-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '200', status: 'SETTLED' }], status: 'READY', unit: 'POINTS' },
      { id: 'orders', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e6-7b39-8a4e-73af0c1d2e3f', status: 'PAID' }], status: 'READY' },
      { id: 'tickets', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e7-7b39-8a4e-73af0c1d2e3f', status: 'OPEN' }], status: 'READY' },
      { id: 'audit', items: [{ action: 'VIEWED', id: '0198f7a4-c6e8-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T07:00:00.000Z' }], status: 'READY' },
    ], user: { displayName: '路由用户', id: userId, phoneMasked: '138****8000', status: 'ACTIVE' },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('configured user detail route', () => {
  it('renders the authoritative user detail view instead of the unavailable fallback', async () => {
    const token = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, signingKey);
    const port: UserDetailPort = { async getUserDetail() { return view; } };

    render(await renderUserDetailRoute(userId, { context: { sessionToken: token, signingKey }, port }));

    expect(screen.getAllByText('路由用户')).toHaveLength(2);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('ACTIVE');
    expect(screen.queryByText('用户详情不可用')).not.toBeInTheDocument();
  });

  it('renders explicit 400, 403, 404, and dependency states without exposing detail data', async () => {
    const token = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, signingKey);
    const context = { sessionToken: token, signingKey };
    const denied: UserDetailPort = { async getUserDetail() { throw new UserDetailPortError('FORBIDDEN'); } };
    const missing: UserDetailPort = { async getUserDetail() { throw new UserDetailPortError('NOT_FOUND'); } };
    const unavailable: UserDetailPort = { async getUserDetail() { throw new UserDetailPortError('DEPENDENCY'); } };

    const { rerender } = render(await renderUserDetailRoute('invalid', { context, port: denied }));
    expect(screen.getByText(/400/u)).toBeVisible();
    rerender(await renderUserDetailRoute(userId, { context, port: denied }));
    expect(screen.getByText(/403/u)).toBeVisible();
    rerender(await renderUserDetailRoute(userId, { context, port: missing }));
    expect(screen.getByText(/404/u)).toBeVisible();
    rerender(await renderUserDetailRoute(userId, { context, port: unavailable }));
    expect(screen.getByText(/依赖服务错误/u)).toBeVisible();
    expect(screen.queryByText('路由用户')).not.toBeInTheDocument();
  });

  it('selects and renders every authoritative operational section from the real route', async () => {
    const account = view.tabs.find((tab): tab is Extract<UserDetailView['tabs'][number], { id: 'account' }> => tab.id === 'account');
    if (!account) throw new Error('missing account fixture');
    const complete: UserDetailView = {
      ...view,
      deniedTabs: [],
      tabs: [
        { ...account, account: { ...account.account, tags: ['vip'], registrationSource: 'WEB', spendingTier: 'HIGH' }, session: { devices: [{ id: '0198f7a4-c6e0-7b39-8a4e-73af0c1d2e3f', lastSeenAt: '2026-08-31T08:00:00.000Z', platform: 'iOS', status: 'ACTIVE' }], lastActiveAt: '2026-08-31T08:00:00.000Z', loginRecords: [{ deviceLabel: 'iPhone', id: '0198f7a4-c6e1-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', status: 'SUCCESS' }], status: 'ACTIVE' } },
        { id: 'tasks', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e2-7b39-8a4e-73af0c1d2e3f', status: 'SUCCEEDED' }], status: 'READY' },
      { adjustmentHistory: [{ direction: 'CREDIT', id: '0198f7a4-c6e5-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '5', status: 'APPROVED' }], balance: '100', consumptionHistory: [{ direction: 'DEBIT', id: '0198f7a4-c6e4-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '10', status: 'SETTLED' }], frozenBalance: '20', id: 'wallet', rechargeHistory: [{ direction: 'CREDIT', id: '0198f7a4-c6e3-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '200', status: 'SETTLED' }], status: 'READY', unit: 'POINTS' },
        { id: 'orders', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e6-7b39-8a4e-73af0c1d2e3f', status: 'PAID' }], status: 'READY' },
        { id: 'tickets', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e7-7b39-8a4e-73af0c1d2e3f', status: 'OPEN' }], status: 'READY' },
        { id: 'audit', items: [{ action: 'VIEWED', id: '0198f7a4-c6e8-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T07:00:00.000Z' }], status: 'READY' },
      ],
    };
    const port: UserDetailPort = { async getUserDetail() { return complete; } };
    const fullToken = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read', 'tasks:read', 'finance:read', 'tickets:read', 'audit:read'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, signingKey);
    render(await renderUserDetailRoute(userId, { context: { sessionToken: fullToken, signingKey }, port }));
    expect(screen.getByText('登录设备')).toBeVisible();
    expect(screen.getByText('登录记录')).toBeVisible();
    for (const [tab, text] of [['任务', '0198f7a4-c6e2'], ['钱包', '冻结点数'], ['订单', '0198f7a4-c6e6'], ['工单', '0198f7a4-c6e7'], ['审计', 'VIEWED']] as const) {
      fireEvent.click(screen.getByRole('tab', { name: tab }));
      expect(screen.getByRole('tabpanel')).toHaveTextContent(text);
    }
    expect(screen.getByRole('tabpanel')).toHaveTextContent('VIEWED');
  });

  it('intersects real HTTP-authorized tabs with local permissions before rendering', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(authoritativePayload()), { headers: { 'Content-Type': 'application/json' } })));
    const restrictedToken = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, signingKey);
    const restrictedPort = createHttpUserOperationPorts({ apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' }).detailPort;
    const { rerender } = render(await renderUserDetailRoute(userId, { context: { sessionToken: restrictedToken, signingKey }, port: restrictedPort }));
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: '任务' })).not.toBeInTheDocument();
    expect(screen.queryByText('SUCCEEDED')).not.toBeInTheDocument();

    const fullToken = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read', 'tasks:read', 'finance:read', 'tickets:read', 'audit:read'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, signingKey);
    rerender(await renderUserDetailRoute(userId, { context: { sessionToken: fullToken, signingKey }, port: restrictedPort }));
    expect(screen.getAllByRole('tab')).toHaveLength(6);
    fireEvent.click(screen.getByRole('tab', { name: '任务' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('SUCCEEDED');
    fireEvent.click(screen.getByRole('tab', { name: '钱包' }));
    expect(within(screen.getByRole('region', { name: '充值历史' })).getByText('CREDIT')).toBeVisible();
    expect(within(screen.getByRole('region', { name: '消费历史' })).getByText('DEBIT')).toBeVisible();
    expect(screen.getByRole('tabpanel')).not.toHaveTextContent('—');
  });

  it('rejects PENDING at the real route boundary and renders CLOSED without a status action', async () => {
    const token = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read', 'users:status'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, signingKey);
    const pending = authoritativePayload();
    (pending.tabs[0] as { account: { status: string } }).account.status = 'PENDING';
    pending.user.status = 'PENDING';
    pending.allowedStatusTransitions = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(pending), { headers: { 'Content-Type': 'application/json' } })));
    const pendingPort = createHttpUserOperationPorts({ apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' }).detailPort;
    const { rerender } = render(await renderUserDetailRoute(userId, { context: { sessionToken: token, signingKey }, port: pendingPort }));
    expect(screen.getByText(/依赖服务错误/u)).toBeVisible();

    const closed = authoritativePayload();
    (closed.tabs[0] as { account: { status: string } }).account.status = 'CLOSED';
    closed.user.status = 'CLOSED';
    closed.allowedStatusTransitions = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(closed), { headers: { 'Content-Type': 'application/json' } })));
    const closedPort = createHttpUserOperationPorts({ apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' }).detailPort;
    rerender(await renderUserDetailRoute(userId, { context: { sessionToken: token, signingKey }, port: closedPort }));
    expect(screen.getByText('账户状态').nextElementSibling).toHaveTextContent('CLOSED');
    expect(screen.queryByRole('button', { name: '封禁用户' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '解封用户' })).not.toBeInTheDocument();
  });

  it('renders a real HTTP detail with an authoritative empty transition set and hides status actions', async () => {
    const payload = authoritativePayload();
    payload.allowedStatusTransitions = [];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } })));
    const token = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read', 'users:status'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, signingKey);
    const port = createHttpUserOperationPorts({ apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' }).detailPort;

    render(await renderUserDetailRoute(userId, { context: { sessionToken: token, signingKey }, port }));

    expect(screen.getByText('账户状态').nextElementSibling).toHaveTextContent('ACTIVE');
    expect(screen.queryByRole('button', { name: '封禁用户' })).not.toBeInTheDocument();
    expect(screen.queryByText(/依赖服务错误/u)).not.toBeInTheDocument();
  });
});
