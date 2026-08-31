/* eslint-disable @typescript-eslint/require-await -- focused fakes model protected server actions. */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

import { UserDetail } from '../components/user-detail';
import type { UserDetailView } from '../lib/user-detail-view-loader';

const userId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const approverId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';

function view(canAdjust = true): UserDetailView {
  return {
    canRequestWalletAdjustment: canAdjust,
    currentActorId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
    deniedTabs: ['tasks', 'wallet', 'orders', 'tickets', 'audit'],
    eligibleApprovers: [{ displayName: '复核管理员', id: approverId }],
    tabs: [{
      account: {
        createdAt: '2026-08-30T10:00:00.000Z',
        displayName: '测试用户',
        phoneMasked: '138****8000',
        registrationSource: 'WEB',
        spendingTier: 'HIGH',
        status: 'ACTIVE',
        tags: [],
      },
      id: 'account',
      session: { devices: [], lastActiveAt: '2026-08-31T08:00:00.000Z', loginRecords: [], status: 'ACTIVE' },
      status: 'READY',
    }],
    user: { displayName: '测试用户', id: userId, phoneMasked: '138****8000', status: 'ACTIVE' },
  };
}

const preview = async () => ({
  after: '110',
  before: '100',
  direction: 'CREDIT' as const,
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
  impact: 'ledger',
  points: '10',
  policy: 'two-person',
  previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456',
});

const accepted = async () => ({
  auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f',
  ok: true as const,
  requestId: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f',
  status: 'PENDING_APPROVAL' as const,
});

function openAndFill() {
  fireEvent.click(screen.getByRole('button', { name: '调整点数' }));
  expect(screen.getByRole('dialog', { name: '申请调整点数' })).toBeVisible();
  fireEvent.change(screen.getByLabelText('调整方向'), { target: { value: 'CREDIT' } });
  fireEvent.change(screen.getByLabelText('调整点数'), { target: { value: '10' } });
  fireEvent.change(screen.getByLabelText('调整原因'), { target: { value: '人工补偿' } });
  fireEvent.change(screen.getByLabelText('复核人'), { target: { value: approverId } });
}

describe('wallet adjustment dialog lifecycle', () => {
  it('opens from the authorized trigger, cancels, restores focus, and reopens with fresh state', async () => {
    render(<UserDetail view={view()} onAdjustmentPreview={preview} onAdjustmentRequest={accepted} />);
    const trigger = screen.getByRole('button', { name: '调整点数' });
    openAndFill();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));

    await waitFor(() => { expect(screen.queryByRole('dialog', { name: '申请调整点数' })).not.toBeInTheDocument(); });
    expect(trigger).toHaveFocus();
    fireEvent.click(trigger);
    expect(screen.getByLabelText('调整方向')).toHaveValue('');
    expect(screen.getByLabelText('调整点数')).toHaveValue('');
    expect(screen.getByLabelText('调整原因')).toHaveValue('');
    expect(screen.getByLabelText('复核人')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' })).not.toBeChecked();
  });

  it('closes with Escape or the Fluent backdrop and restores the trigger focus', async () => {
    render(<UserDetail view={view()} onAdjustmentPreview={preview} onAdjustmentRequest={accepted} />);
    fireEvent.click(screen.getByRole('button', { name: '调整点数' }));
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
    const trigger = screen.getByRole('button', { name: '调整点数' });
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const backdrop = document.querySelector('.fui-DialogSurface__backdrop');
    expect(backdrop).toBeInstanceOf(HTMLElement);
    fireEvent.click(backdrop as HTMLElement);
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
    expect(trigger).toHaveFocus();
  });

  it('cannot close or replay while submission is pending, then offers an explicit completion close', async () => {
    let finish!: (value: Awaited<ReturnType<typeof accepted>>) => void;
    const onRequest = vi.fn(() => new Promise<Awaited<ReturnType<typeof accepted>>>((resolve) => { finish = resolve; }));
    render(<UserDetail view={view()} onAdjustmentPreview={preview} onAdjustmentRequest={onRequest} />);
    openAndFill();
    fireEvent.click(screen.getByRole('button', { name: '获取权威预览' }));
    await screen.findByText(/调整后：\s*110/u);
    fireEvent.click(screen.getByRole('checkbox', { name: '我已核对影响范围，并确认提交双人审批申请' }));
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));
    fireEvent.click(screen.getByRole('button', { name: '提交申请' }));

    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeVisible();
    expect(onRequest).toHaveBeenCalledTimes(1);
    finish(await accepted());

    expect(await screen.findByRole('button', { name: '完成并关闭' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: '提交申请' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '完成并关闭' }));
    await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
    fireEvent.click(screen.getByRole('button', { name: '调整点数' }));
    expect(screen.queryByText(/申请待审批/u)).not.toBeInTheDocument();
    expect(screen.getByLabelText('调整点数')).toHaveValue('');
  });

  it('does not place the trigger or dialog in the DOM without server authorization', () => {
    render(<UserDetail view={view(false)} onAdjustmentPreview={preview} onAdjustmentRequest={accepted} />);
    expect(screen.queryByRole('button', { name: '调整点数' })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
