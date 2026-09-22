/* eslint-disable @typescript-eslint/require-await -- async fakes implement port contracts. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const routerRefresh = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: routerRefresh }) }));

import {
  AdjustmentDialog,
  validateAdjustmentRequest,
} from '../components/adjustment-dialog';
import { UserDetail } from '../components/user-detail';
import { OverviewCockpit } from '../components/overview-cockpit';
import {
  type UserExportPort,
  type WalletAdjustmentRequestPort,
  createUserCsvExportAction,
  createWalletAdjustmentRequestAction,
} from '../lib/user-operation-actions';
import { createUserStatusAction, type UserStatusPort } from '../lib/protected-user-action';
import type { UserDetailView } from '../lib/user-detail-view-loader';
import { signAdminSession } from '../lib/session-auth';
import { isUuidV7 } from '../lib/uuid-v7';

const user = {
  id: 'user-1',
  displayName: '测试用户',
  phoneMasked: '138****8000',
  status: 'ACTIVE' as const,
};

function userDetailView(canRequestWalletAdjustment = false): UserDetailView {
  return {
    canRequestWalletAdjustment,
    deniedTabs: ['tasks', 'wallet', 'orders', 'tickets', 'audit'],
    tabs: [{ account: { createdAt: '2026-08-30T10:00:00.000Z', displayName: user.displayName, phoneMasked: user.phoneMasked, registrationSource: 'WEB', status: 'ACTIVE', spendingTier: 'HIGH', tags: ['vip'] }, id: 'account', session: { devices: [], lastActiveAt: '2026-08-31T08:00:00.000Z', loginRecords: [], status: 'ACTIVE' }, status: 'READY' }],
    user,
  };
}

function statusView(status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED'): UserDetailView {
  const base = userDetailView();
  const account = base.tabs[0];
  if (!account || account.id !== 'account') throw new Error('missing account fixture');
  return {
    ...base,
    allowedStatusTransitions: status === 'CLOSED' ? [] : [status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE'],
    canChangeStatus: status !== 'CLOSED',
    tabs: [{ ...account, account: { ...account.account, status } }],
    user: { ...base.user, id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', status },
  };
}

describe('user operations', () => {
  it('hides the state action without the server-authorized status capability', () => {
    render(<UserDetail view={userDetailView()} />);
    expect(screen.queryByRole('button', { name: '封禁用户' })).not.toBeInTheDocument();
  });
  it('does not render wallet adjustment without permission', () => {
    render(<UserDetail view={userDetailView()} />);

    expect(
      screen.queryByRole('button', { name: '调整点数' }),
    ).not.toBeInTheDocument();
  });

  it('requires reason and a second approver', () => {
    render(<AdjustmentDialog userId={user.id} onPreview={async () => ({ after: '1', before: '0', direction: 'CREDIT', expiresAt: new Date(Date.now() + 60_000).toISOString(), impact: 'ledger', points: '1', policy: 'two-person', previewToken: 'preview-token-1234' })} onRequest={async () => ({ auditRecordId: 'audit-1', ok: true, requestId: 'request-1', status: 'PENDING_APPROVAL' })} />);

    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(screen.getByText('请填写调整原因')).toBeVisible();

    fireEvent.change(screen.getByLabelText('调整原因'), {
      target: { value: '补偿渲染失败' },
    });
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(screen.getByText('请选择复核人')).toBeVisible();
  });

  it('renders only the masked phone supplied by the server-authorized view', () => {
    render(<UserDetail view={userDetailView()} />);

    expect(screen.getAllByText('138****8000')).toHaveLength(2);
    expect(screen.queryByText('13800138000')).not.toBeInTheDocument();
  });

  it('reuses a stable status intent on retry, suppresses double click, and locks after success', async () => {
    const forms: FormData[] = []; let attempt = 0;
    const view: UserDetailView = { ...userDetailView(), allowedStatusTransitions: ['SUSPENDED'], canChangeStatus: true, user: { ...userDetailView().user, id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' } };
    render(<UserDetail view={view} onStatusChange={async (form) => { forms.push(form); attempt += 1; if (attempt === 1) throw new Error('timeout'); return { auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', ok: true, requestId: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }; }} />);
    fireEvent.change(screen.getByLabelText('状态变更原因'), { target: { value: '违反规则' } }); fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险状态变更' }));
    const button = screen.getByRole('button', { name: '封禁用户' }); fireEvent.click(button); fireEvent.click(button);
    await screen.findByText('状态变更被拒绝或暂时不可用'); expect(forms).toHaveLength(1);
    fireEvent.click(button); await screen.findByText(/状态变更请求已受理/u); expect(forms).toHaveLength(2); expect(forms[1]?.get('intentId')).toBe(forms[0]?.get('intentId')); expect(isUuidV7(forms[0]?.get('intentId'))).toBe(true); expect(button).toBeDisabled();
    fireEvent.click(button); await waitFor(() => { expect(forms).toHaveLength(2); });
  });

  it.each([
    ['ACTIVE', '封禁用户', 'SUSPENDED', '解封用户'],
    ['SUSPENDED', '解封用户', 'ACTIVE', '封禁用户'],
  ] as const)('keeps %s authoritative until refreshed to %s, keeps unchanged props locked, then safely recomputes the reverse action', async (currentStatus, actionName, returnedStatus, reverseActionName) => {
    routerRefresh.mockClear();
    const auditRecordId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
    const requestId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
    const submittedForms: FormData[] = [];
    const onStatusChange = async (form: FormData) => { submittedForms.push(form); return { auditRecordId, ok: true as const, requestId }; };
    const { rerender } = render(<UserDetail view={statusView(currentStatus)} onStatusChange={onStatusChange} />);
    fireEvent.change(screen.getByLabelText('状态变更原因'), { target: { value: '违反规则' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险状态变更' }));
    fireEvent.click(screen.getByRole('button', { name: actionName }));

    expect(await screen.findByText(new RegExp(`${requestId}.*${auditRecordId}`, 'u'))).toBeVisible();
    const accountStatus = screen.getByText('账户状态').nextElementSibling;
    expect(accountStatus).toHaveTextContent(currentStatus);
    expect(screen.queryByRole('button', { name: actionName })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: reverseActionName })).not.toBeInTheDocument();
    expect(routerRefresh).toHaveBeenCalledTimes(1);
    const originalIntent = submittedForms[0]?.get('intentId');
    expect(isUuidV7(originalIntent)).toBe(true);

    rerender(<UserDetail view={statusView(currentStatus)} onStatusChange={onStatusChange} />);
    expect(screen.getByText('账户状态').nextElementSibling).toHaveTextContent(currentStatus);
    expect(screen.queryByRole('button', { name: actionName })).not.toBeInTheDocument();

    rerender(<UserDetail view={statusView(returnedStatus)} onStatusChange={onStatusChange} />);
    await waitFor(() => {
      expect(screen.getByText('账户状态').nextElementSibling).toHaveTextContent(returnedStatus);
      expect(screen.getByRole('button', { name: reverseActionName })).toBeEnabled();
      expect(screen.getByLabelText('状态变更原因')).toHaveValue('');
      expect(screen.getByRole('checkbox', { name: '我确认这是高风险状态变更' })).not.toBeChecked();
      expect(screen.queryByText(new RegExp(requestId, 'u'))).not.toBeInTheDocument();
    });
    fireEvent.change(screen.getByLabelText('状态变更原因'), { target: { value: '反向操作需重新确认' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险状态变更' }));
    fireEvent.click(screen.getByRole('button', { name: reverseActionName }));
    await waitFor(() => { expect(submittedForms).toHaveLength(2); });
    const reverseIntent = submittedForms[1]?.get('intentId');
    expect(isUuidV7(reverseIntent)).toBe(true);
    expect(reverseIntent).not.toBe(originalIntent);
  });

  it('keeps the original visible status and does not refresh when a status change fails', async () => {
    routerRefresh.mockClear();
    render(<UserDetail view={statusView('ACTIVE')} onStatusChange={async () => { throw new Error('denied'); }} />);
    fireEvent.change(screen.getByLabelText('状态变更原因'), { target: { value: '违反规则' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险状态变更' }));
    fireEvent.click(screen.getByRole('button', { name: '封禁用户' }));

    expect(await screen.findByText('状态变更被拒绝或暂时不可用')).toBeVisible();
    expect(screen.getByText('账户状态').nextElementSibling).toHaveTextContent('ACTIVE');
    expect(screen.getByRole('button', { name: '封禁用户' })).toBeEnabled();
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed request identity', { auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', ok: true, requestId: 'request-1' }],
    ['malformed audit identity', { auditRecordId: 'audit-1', ok: true, requestId: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }],
  ])('rejects a client-visible status result with %s', async (_name, result) => {
    routerRefresh.mockClear();
    render(<UserDetail view={statusView('ACTIVE')} onStatusChange={async () => result as never} />);
    fireEvent.change(screen.getByLabelText('状态变更原因'), { target: { value: '违反规则' } });
    fireEvent.click(screen.getByRole('checkbox', { name: '我确认这是高风险状态变更' }));
    fireEvent.click(screen.getByRole('button', { name: '封禁用户' }));
    expect(await screen.findByText('状态变更被拒绝或暂时不可用')).toBeVisible();
    expect(screen.getByText('账户状态').nextElementSibling).toHaveTextContent('ACTIVE');
    expect(routerRefresh).not.toHaveBeenCalled();
  });

  it('renders CLOSED as terminal and exposes no suspend or unban action', () => {
    render(<UserDetail view={statusView('CLOSED')} onStatusChange={async () => ({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', ok: true, requestId: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' })} />);
    expect(screen.getByText('账户状态').nextElementSibling).toHaveTextContent('CLOSED');
    expect(screen.queryByRole('button', { name: '封禁用户' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '解封用户' })).not.toBeInTheDocument();
  });

  it('validates canonical integer point strings without coercing to an unsafe Number', () => {
    expect(
      validateAdjustmentRequest({
        approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f',
        currentActorId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        direction: 'DEBIT',
        points: '900719925474099325',
        reason: '异常任务补偿',
      }),
    ).toEqual({ direction: 'DEBIT', ok: true, points: 900719925474099325n });
    expect(
      validateAdjustmentRequest({
        approverId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        currentActorId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        direction: 'CREDIT',
        points: '1.234',
        reason: '',
      }),
    ).toEqual({
      errors: ['请填写调整原因', '调整点数格式无效', '复核人不得与申请人相同'],
      ok: false,
    });
  });
});

describe('user status server action', () => {
  it('requires confirmation and forwards trusted scope, trace and idempotency metadata for an active user ban', async () => {
    const key = 'user-status-server-action-signing-key-at-least-32-bytes';
    const token = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:status'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, key);
    let received: unknown;
    let receivedScope: unknown;
    const port: UserStatusPort = { async requestStatusChange(input) { received = input; return { auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f' }; } };
    const form = new FormData(); form.set('userId', '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f'); form.set('currentStatus', 'ACTIVE'); form.set('reason', '违反平台使用规则'); form.set('highRiskConfirmed', 'true'); form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
    await expect(createUserStatusAction({ createCorrelationId: () => '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', createTraceId: () => '00112233445566778899aabbccddeeff', guardContext: { sessionToken: token, signingKey: key }, port, scopePort: { async getUserScope(input) { receivedScope = input; return { assignedAdminIds: [], ownerAdminId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }; } } })(form)).resolves.toEqual({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', ok: true, requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f' });
    const requestContext = { correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', traceId: '00112233445566778899aabbccddeeff' };
    expect(receivedScope).toEqual({ requestContext, trustedSessionToken: token, userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' });
    expect(received).toMatchObject({ audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, requestContext, targetStatus: 'SUSPENDED', trustedSessionToken: token });
    expect((received as { audit: { idempotencyKey: string }; requestContext: { correlationId: string; traceId: string } }).audit.idempotencyKey).not.toBe(requestContext.correlationId);
  });

  it('fails closed on invalid or duplicate state transitions before invoking the port', async () => {
    const key = 'user-status-server-action-signing-key-at-least-32-bytes';
    const token = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:status'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, key);
    let calls = 0;
    const port: UserStatusPort = { async requestStatusChange() { calls += 1; return { auditRecordId: 'audit-record-1', requestId: 'request-1' }; } };
    const form = new FormData(); form.set('userId', 'not-a-uuid'); form.set('currentStatus', 'PENDING'); form.set('reason', '原因'); form.set('highRiskConfirmed', 'true');
    await expect(createUserStatusAction({ guardContext: { sessionToken: token, signingKey: key }, port, scopePort: { async getUserScope() { return { assignedAdminIds: [], ownerAdminId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }; } } })(form)).rejects.toThrow('状态变更无效');
    expect(calls).toBe(0);
  });

  it('rejects a whitespace-wrapped status user identifier before scope or mutation ports', async () => {
    let scopeCalls = 0; let mutationCalls = 0;
    const action = createUserStatusAction({
      guardContext: { sessionToken: await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:status'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, 'status-action-signing-key-at-least-32-bytes'), signingKey: 'status-action-signing-key-at-least-32-bytes' },
      port: { async requestStatusChange() { mutationCalls += 1; return { auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', requestId: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }; } },
      scopePort: { async getUserScope() { scopeCalls += 1; return { assignedAdminIds: [], ownerAdminId: null }; } },
    });
    const form = new FormData(); form.set('userId', ' 0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f'); form.set('currentStatus', 'ACTIVE'); form.set('reason', ' 合规原因 '); form.set('highRiskConfirmed', 'true'); form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
    await expect(action(form)).rejects.toThrow('状态变更无效');
    expect({ mutationCalls, scopeCalls }).toEqual({ mutationCalls: 0, scopeCalls: 0 });
  });

  it('rejects missing reason or confirmation and backend conflict without a success outcome', async () => {
    const key = 'user-status-server-action-signing-key-at-least-32-bytes'; const sessionToken = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:status'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, key);
    let calls = 0; const port: UserStatusPort = { async requestStatusChange() { calls += 1; throw new Error('backend conflict'); } };
    const action = createUserStatusAction({ guardContext: { sessionToken, signingKey: key }, port, scopePort: { async getUserScope() { return { assignedAdminIds: [], ownerAdminId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }; } } });
    const form = new FormData(); form.set('userId', '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f'); form.set('currentStatus', 'ACTIVE');
    await expect(action(form)).rejects.toThrow('状态变更无效'); expect(calls).toBe(0);
    form.set('reason', '违反规则'); form.set('highRiskConfirmed', 'true'); form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f'); await expect(action(form)).rejects.toThrow('backend conflict'); expect(calls).toBe(1);
  });
});

describe('wallet adjustment server action', () => {
  const signingKey = 'wallet-adjustment-signing-key-at-least-32-bytes';

  async function token(permissions: readonly string[]): Promise<string> {
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

  function requestForm(): FormData {
    const form = new FormData();
    form.set('userId', '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f');
    form.set('direction', 'DEBIT');
    form.set('points', '900719925474099325');
    form.set('reason', '异常任务补偿');
    form.set('approverId', '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f');
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
    form.set('previewToken', 'preview-token-1234');
    return form;
  }

  it('never invokes a direct mutation when wallet adjustment permission is absent', async () => {
    let submissions = 0;
    const adjustmentPort: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() { return [{ displayName: '复核管理员', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }]; },
      async submitAdjustmentRequest() {
        submissions += 1;
        return { auditRecordId: 'audit-1', requestId: 'request-1', status: 'PENDING_APPROVAL' as const };
      },
    };
    const action = createWalletAdjustmentRequestAction({
      adjustmentPort,
      guardContext: { sessionToken: await token(['users:read']), signingKey },
      scopePort: {
        async getUserScope() {
          return { assignedAdminIds: [], ownerAdminId: null };
        },
      },
    });

    await expect(action(requestForm())).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(submissions).toBe(0);
  });

  it('submits a two-person approval request with exact integer points and audit context', async () => {
    let received: unknown;
    let receivedEligible: unknown;
    let receivedScope: unknown;
    const sessionToken = await token(['wallet:adjust']);
    const adjustmentPort: WalletAdjustmentRequestPort = {
      async getEligibleApprovers(input) { receivedEligible = input; return [{ displayName: '复核管理员', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }]; },
      async submitAdjustmentRequest(input) {
        received = input;
        return { auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f', status: 'PENDING_APPROVAL' as const };
      },
    };
    const action = createWalletAdjustmentRequestAction({
      adjustmentPort,
      guardContext: {
        sessionToken,
        signingKey,
      },
      scopePort: {
        async getUserScope(input) {
          receivedScope = input;
          return { assignedAdminIds: [], ownerAdminId: null };
        },
      },
      createCorrelationId: () => '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
      createTraceId: () => '00112233445566778899aabbccddeeff',
    });

    await expect(action(requestForm())).resolves.toEqual({
      auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f',
      ok: true,
      requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f',
      status: 'PENDING_APPROVAL',
    });
    expect(received).toMatchObject({
      approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f',
      audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' },
      direction: 'DEBIT',
      points: 900719925474099325n,
      requestContext: { correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', traceId: '00112233445566778899aabbccddeeff' },
      userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
    });
    expect(receivedScope).toEqual({ requestContext: { correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', traceId: '00112233445566778899aabbccddeeff' }, trustedSessionToken: sessionToken, userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' });
    expect(receivedEligible).toMatchObject({ requestContext: { correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', traceId: '00112233445566778899aabbccddeeff' } });
    expect(received).not.toHaveProperty('amountMinor');
  });
});

describe('CSV export server action', () => {
  const signingKey = 'csv-export-signing-key-at-least-32-bytes';

  it('requires export permission and sends reason plus auditable request ids without a download URL', async () => {
    let received: unknown;
    const exportPort: UserExportPort = {
      async requestCsvExport(input) {
        received = input;
        return { auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://download.example.invalid/export', expiresAt: new Date(Date.now() + 60_000).toISOString() };
      },
    };
    const sessionToken = await signAdminSession(
      {
        dataScope: 'ASSIGNED',
        expiresAt: Date.now() + 60_000,
        permissions: ['users:export'],
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f",
      },
      signingKey,
    );
    const action = createUserCsvExportAction({
      createTraceId: () => '00112233445566778899aabbccddeeff',
      exportPort,
      guardContext: { sessionToken, signingKey },
    });
    const form = new FormData();
    form.set('reason', '月度合规核对');
    form.set('query', 'account-9');
    form.set('highRiskConfirmed', 'true');
    form.set('intentId', '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');

    await expect(action(form)).resolves.toMatchObject({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://download.example.invalid/export', ok: true });
    expect(received).toMatchObject({
      audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' },
      reason: '月度合规核对',
      scope: 'ASSIGNED',
    });
    expect(received).not.toHaveProperty('downloadUrl');
  });
});

describe('overview safe states', () => {
  it('labels unavailable metrics as non-authoritative with a source timestamp state', () => {
    render(
      <OverviewCockpit
        datasets={[
          { id: 'operations', label: '运营指标', measures: [], reason: 'UPSTREAM_FAILURE', status: 'ERROR' },
          { id: 'finance', label: '财务指标', measures: [], sourceTimestamp: '2026-08-31T08:00:00.000Z', status: 'STALE', warning: '等待刷新' },
          { id: 'suppliers', label: '供应商风险', measures: [], sourceTimestamp: '2026-08-31T08:00:00.000Z', status: 'EMPTY' },
        ]}
      />,
    );

    expect(screen.getByText('运营指标')).toBeVisible();
    expect(screen.getAllByText(/来源时间\s*未提供/u)).toHaveLength(1);
    expect(screen.getByText('数据不完整，不能作为权威计算依据')).toBeVisible();
  });
});
