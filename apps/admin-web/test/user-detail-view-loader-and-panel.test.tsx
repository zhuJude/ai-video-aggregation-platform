/* eslint-disable @typescript-eslint/require-await -- test ports deliberately model async boundaries. */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { UserDetail } from '../components/user-detail';
import {
  type UserDetailPort,
  type UserDetailView,
  loadUserDetailView,
} from '../lib/user-detail-view-loader';
import { signAdminSession } from '../lib/session-auth';

const signingKey = 'user-detail-view-loader-signing-key-at-least-32-bytes';
const userId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';

const detailView: UserDetailView = {
  canRequestWalletAdjustment: true,
  deniedTabs: ['wallet', 'orders', 'tickets', 'audit'],
  tabs: [
    {
      account: {
        createdAt: '2026-08-30T10:00:00.000Z',
        displayName: '测试用户',
        phoneMasked: '138****8000',
        registrationSource: 'WEB',
        status: 'ACTIVE',
        spendingTier: 'HIGH',
        tags: ['vip'],
      },
      id: 'account',
      session: { devices: [{ id: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', lastSeenAt: '2026-08-31T08:00:00.000Z', platform: 'iOS', status: 'ACTIVE' }], lastActiveAt: '2026-08-31T08:00:00.000Z', loginRecords: [{ deviceLabel: 'iPhone', id: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', status: 'SUCCESS' }], status: 'ACTIVE' },
      status: 'READY',
    },
    {
      id: 'tasks',
      items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f', status: 'SUCCEEDED' }],
      status: 'READY',
    },
  ],
  user: { displayName: '测试用户', id: userId, phoneMasked: '138****8000', status: 'ACTIVE' },
};

const walletDetailView: UserDetailView = {
  ...detailView,
  deniedTabs: ['orders', 'tickets', 'audit'],
  tabs: [
    ...detailView.tabs,
    {
      adjustmentHistory: [],
      balance: '1',
      consumptionHistory: [],
      frozenBalance: '0',
      id: 'wallet',
      rechargeHistory: [],
      status: 'READY',
      unit: 'POINTS',
    },
  ],
};

async function createToken(permissions: readonly string[]): Promise<string> {
  return signAdminSession(
    {
      dataScope: 'ALL',
      expiresAt: Date.now() + 60_000,
      permissions,
      subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f",
    },
    signingKey,
  );
}

describe('server user-detail view loader', () => {
  it('rejects a non-canonical UUID without invoking the authoritative port', async () => {
    let calls = 0;
    const port: UserDetailPort = {
      async getUserDetail() {
        calls += 1;
        return detailView;
      },
    };

    await expect(
      loadUserDetailView('not-a-uuid', {
        context: { sessionToken: await createToken(['users:read']), signingKey },
        port,
      }),
    ).resolves.toEqual({ code: 'INVALID_ID', ok: false });
    expect(calls).toBe(0);
  });

  it('renders bounded account, device, login, and wallet history sections from the server view', () => {
    render(<UserDetail view={walletDetailView} />);
    expect(screen.getByText('WEB')).toBeVisible();
    expect(screen.getByText('vip')).toBeVisible();
    expect(screen.getByText('登录设备')).toBeVisible();
    expect(screen.getByText('登录记录')).toBeVisible();
  });

  it('rejects an unauthorised session before invoking the authoritative port', async () => {
    let calls = 0;
    const port: UserDetailPort = {
      async getUserDetail() {
        calls += 1;
        return detailView;
      },
    };

    await expect(
      loadUserDetailView(userId, {
        context: { sessionToken: await createToken([]), signingKey },
        port,
      }),
    ).resolves.toEqual({ code: 'FORBIDDEN', ok: false });
    expect(calls).toBe(0);
  });

  it.each([{ permissions: ['users:read'] }, { permissions: ['users:read', 'users:phone-exact'] }])('forwards the trusted server session and preserves only the authoritative phone mask for permissions $permissions', async ({ permissions }) => {
    const token = await createToken(permissions);
    let received: unknown;
    const port: UserDetailPort = {
      async getUserDetail(input) {
        received = input;
        return detailView;
      },
    };

    await expect(
      loadUserDetailView(userId, { context: { sessionToken: token, signingKey }, port }),
    ).resolves.toMatchObject({
      ok: true,
       view: { user: { phoneMasked: '138****8000' } },
    });
    expect(received).toMatchObject({ trustedSessionToken: token, userId });
    const requestContext = (received as { requestContext: { correlationId: string; traceId: string } }).requestContext;
    expect(requestContext.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    expect(requestContext.traceId).toMatch(/^[0-9a-f]{32}$/u);
  });

  it('does not override a backend scope denial with client-side scope logic', async () => {
    const port: UserDetailPort = {
      async getUserDetail() {
        throw new Error('FORBIDDEN');
      },
    };

    await expect(
      loadUserDetailView(userId, {
        context: { sessionToken: await createToken(['users:read']), signingKey },
        port,
      }),
    ).resolves.toEqual({ code: 'FORBIDDEN', ok: false });
  });

  it('intersects a backend wallet capability with the verified local wallet permission', async () => {
    const port: UserDetailPort = { async getUserDetail() { return walletDetailView; } };
    await expect(loadUserDetailView(userId, { context: { sessionToken: await createToken(['users:read']), signingKey }, port })).resolves.toMatchObject({ ok: true, view: { canRequestWalletAdjustment: false } });
    await expect(loadUserDetailView(userId, { context: { sessionToken: await createToken(['users:read', 'finance:read', 'wallet:adjust']), signingKey }, port })).resolves.toMatchObject({ ok: true, view: { canRequestWalletAdjustment: true } });
  });

  it('requires both verified users:status permission and an authoritative compatible transition', async () => {
    const port: UserDetailPort = { async getUserDetail() { return { ...detailView, allowedStatusTransitions: ['SUSPENDED'] }; } };
    await expect(loadUserDetailView(userId, { context: { sessionToken: await createToken(['users:read', 'users:status']), signingKey }, port })).resolves.toMatchObject({ ok: true, view: { canChangeStatus: true } });
    const deniedPort: UserDetailPort = { async getUserDetail() { return { ...detailView, allowedStatusTransitions: [] }; } };
    await expect(loadUserDetailView(userId, { context: { sessionToken: await createToken(['users:read', 'users:status']), signingKey }, port: deniedPort })).resolves.toMatchObject({ ok: true, view: { canChangeStatus: false } });
  });

  it('passes the verified current actor and removes that actor from backend eligible approvers', async () => {
    const port: UserDetailPort = { async getUserDetail() { return { ...walletDetailView, eligibleApprovers: [{ displayName: '本人', id: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }, { displayName: '复核管理员', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }] }; } };
    await expect(loadUserDetailView(userId, { context: { sessionToken: await createToken(['users:read', 'finance:read', 'wallet:adjust']), signingKey }, port })).resolves.toMatchObject({ ok: true, view: { currentActorId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', eligibleApprovers: [{ displayName: '复核管理员', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }] } });
  });
});

describe('user-detail accessible panels', () => {
  it('renders server-authorized tab content and omits a disallowed tab from the DOM', () => {
    render(<UserDetail view={detailView} />);

    expect(screen.getByRole('tab', { name: '账户与会话' })).toBeVisible();
    expect(screen.getByRole('tabpanel')).toHaveTextContent('测试用户');
    expect(screen.getByRole('tab', { name: '任务' })).toBeVisible();
    expect(screen.queryByRole('tab', { name: '钱包' })).not.toBeInTheDocument();
    expect(screen.queryByText('13800138000')).not.toBeInTheDocument();
    expect(screen.getAllByText('138****8000')).toHaveLength(2);
  });

  it('uses the server-authorized approver picker, excludes the current actor, and forwards an eligible selection', async () => {
    let received: FormData | undefined;
    render(<UserDetail view={{ ...walletDetailView, currentActorId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', eligibleApprovers: [{ displayName: '复核管理员', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }], canRequestWalletAdjustment: true }} onAdjustmentPreview={async (form) => { received = form; return { after: '1', before: '0', direction: 'CREDIT', expiresAt: new Date(Date.now() + 60_000).toISOString(), impact: 'ledger', points: '1', policy: 'two-person', previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456' }; }} onAdjustmentRequest={async () => ({ auditRecordId: '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f', ok: true, requestId: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f', status: 'PENDING_APPROVAL' })} />);
    fireEvent.click(screen.getByRole('button', { name: '调整点数' }));
    expect(screen.getByRole('combobox', { name: '复核人' })).toBeVisible();
    expect(screen.getByRole('option', { name: '复核管理员' })).toHaveValue('0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f');
    expect(screen.queryByRole('option', { name: '本人' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '合规补偿' } });
    fireEvent.change(screen.getByRole('combobox', { name: '复核人' }), { target: { value: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' } });
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    await screen.findByText(/调整后：\s*1/u);
    expect(received?.get('approverId')).toBe('0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f');
  });

  it('keeps an empty authoritative approver picker fail-closed', () => {
    render(<UserDetail view={{ ...walletDetailView, currentActorId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', eligibleApprovers: [], canRequestWalletAdjustment: true }} onAdjustmentPreview={async () => ({ after: '1', before: '0', direction: 'CREDIT', expiresAt: new Date(Date.now() + 60_000).toISOString(), impact: 'ledger', points: '1', policy: 'two-person', previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456' })} onAdjustmentRequest={async () => ({ auditRecordId: '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f', ok: true, requestId: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f', status: 'PENDING_APPROVAL' })} />);
    fireEvent.click(screen.getByRole('button', { name: '调整点数' }));
    expect(screen.getByRole('combobox', { name: '复核人' })).toBeVisible();
    expect(within(screen.getByRole('combobox', { name: '复核人' })).getAllByRole('option')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
    fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '合规补偿' } });
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请选择复核人');
  });

  it('hides a status operation when the backend has not authorized the displayed transition', () => {
    render(<UserDetail view={{ ...detailView, allowedStatusTransitions: [], canChangeStatus: true }} onStatusChange={async () => ({ auditRecordId: 'audit-1', ok: true, requestId: 'request-1' })} />);
    expect(screen.queryByRole('button', { name: '封禁用户' })).not.toBeInTheDocument();
  });
});
