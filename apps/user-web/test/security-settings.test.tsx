import '@testing-library/jest-dom/vitest';

import { randomBytes } from 'node:crypto';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const refresh = vi.hoisted(() => vi.fn<() => Promise<boolean>>());

vi.mock('../lib/auth/client-session', () => ({ coordinateSessionRefresh: refresh }));

import { AccountDeletion } from '../components/account/account-deletion';
import { PhoneChangeForm } from '../components/account/phone-change-form';
import { SessionList } from '../components/account/session-list';
import { runAccountActionWithRefresh } from '../lib/account/client-command';
import { accountGateway } from '../lib/account/gateway';
import { resolveOrCreateMockSubjectForVerifiedPhone } from '../lib/auth/mock-subject-store';
import { createUuidV7 } from '../lib/tasks/identifiers';
import type { AccountActionResult, SecuritySessionView } from '../lib/account/types';

const sessions: readonly SecuritySessionView[] = [
  {
    handle: 'current-safe-handle',
    deviceName: 'iPhone Safari',
    locationMasked: '上海',
    createdAt: '2026-08-28T02:00:00.000Z',
    lastSeenAt: '2026-08-31T02:00:00.000Z',
    expiresAt: '2026-09-28T02:00:00.000Z',
    current: true,
  },
  {
    handle: 'other-safe-handle',
    deviceName: 'Windows Chrome',
    locationMasked: '北京',
    createdAt: '2026-08-27T02:00:00.000Z',
    lastSeenAt: '2026-08-30T02:00:00.000Z',
    expiresAt: '2026-09-27T02:00:00.000Z',
    current: false,
  },
];

const ok = <T,>(data: T): AccountActionResult<T> => ({ ok: true, data });

beforeEach(() => {
  refresh.mockReset();
  process.env.USER_WEB_SUPPORT_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MODE = 'mock';
  process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY = randomBytes(32).toString('base64url');
  process.env.USER_WEB_MOCK_IDENTITY_KEY = randomBytes(32).toString('base64url');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete process.env.USER_WEB_SUPPORT_MODE;
  delete process.env.USER_WEB_COMMERCE_MODE;
  delete process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
  delete process.env.USER_WEB_MOCK_IDENTITY_KEY;
});

describe('security settings', () => {
  it('requires confirmation before revoking another device and restores focus', async () => {
    const user = userEvent.setup();
    const revoke = vi.fn().mockResolvedValue(ok({ revoked: true }));
    render(<SessionList sessions={sessions} onRevoke={revoke} onExitAll={vi.fn()} />);

    const trigger = screen.getByRole('button', { name: '退出 Windows Chrome' });
    await user.click(trigger);

    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('该设备需要重新登录');
    expect(within(dialog).getByRole('button', { name: '确认退出' })).toHaveFocus();
    expect(revoke).not.toHaveBeenCalled();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('never offers a revoke control for the current session', () => {
    render(<SessionList sessions={sessions} onRevoke={vi.fn()} onExitAll={vi.fn()} />);

    const current = screen.getByText('当前设备').closest('article');
    expect(current).not.toBeNull();
    expect(within(current as HTMLElement).queryByRole('button', { name: /退出/ })).toBeNull();
    expect(screen.queryByText(/current-safe-handle|other-safe-handle/)).toBeNull();
  });

  it('protects the current session and rejects a handle from another owner', async () => {
    const first = {
      ownerId: createUuidV7(),
      currentSessionId: createUuidV7(),
      verifiedPhone: '+8613700137000',
    };
    const second = {
      ownerId: createUuidV7(),
      currentSessionId: createUuidV7(),
      verifiedPhone: '+8613600136000',
    };
    const listed = (await accountGateway.listSessions(first)) as readonly SecuritySessionView[];
    const current = listed.find((session) => session.current);
    const other = listed.find((session) => !session.current);
    expect(current).toBeDefined();
    expect(other).toBeDefined();
    await expect(
      accountGateway.revokeSession(current?.handle ?? '', {
        ...first,
        idempotencyKey: createUuidV7(),
      }),
    ).rejects.toThrow('CURRENT_SESSION_PROTECTED');
    await expect(
      accountGateway.revokeSession(other?.handle ?? '', {
        ...second,
        idempotencyKey: createUuidV7(),
      }),
    ).rejects.toThrow('SESSION_NOT_FOUND');
  });

  it('replays a successful revoke after the target session has disappeared', async () => {
    const context = {
      ownerId: createUuidV7(),
      currentSessionId: createUuidV7(),
      verifiedPhone: '+8613700137000',
    };
    const listed = (await accountGateway.listSessions(context)) as readonly SecuritySessionView[];
    const other = listed.find((session) => !session.current);
    expect(other).toBeDefined();
    const command = { ...context, idempotencyKey: createUuidV7() };

    const first = await accountGateway.revokeSession(other?.handle ?? '', command);
    await expect(accountGateway.revokeSession(other?.handle ?? '', command)).resolves.toEqual(
      first,
    );
  });

  it('confirms exit-all and leaves the current-device command to the dedicated action', async () => {
    const user = userEvent.setup();
    const exitAll = vi.fn().mockResolvedValue(ok({ signedOut: true }));
    render(<SessionList sessions={sessions} onRevoke={vi.fn()} onExitAll={exitAll} />);

    await user.click(screen.getByRole('button', { name: '退出全部设备' }));
    expect(exitAll).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认退出全部设备' }));
    expect(exitAll).toHaveBeenCalledTimes(1);
  });

  it('refreshes once and retries a command with the same idempotency key', async () => {
    const key = '0198f4d4-21c2-7b7d-8a03-08a0da2a7101';
    const seen: string[] = [];
    const operation = vi.fn((logicalKey: string) => {
      seen.push(logicalKey);
      return Promise.resolve(
        seen.length === 1
          ? ({ ok: false, outcome: 'SESSION_REFRESH_REQUIRED' } as const)
          : ok({ revoked: true }),
      );
    });
    refresh.mockResolvedValue(true);

    await expect(runAccountActionWithRefresh(key, operation)).resolves.toEqual(
      ok({ revoked: true }),
    );
    expect(seen).toEqual([key, key]);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('uses an anti-enumeration response and respects phone-code cooldown', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const requestCodes = vi.fn().mockResolvedValue(
      ok({
        cooldownSeconds: 60,
        message: '如果手机号可用，验证码将尽快发送。',
      }),
    );
    const verify = vi.fn().mockResolvedValue({ ok: false, outcome: 'DEFINITIVE_FAILURE' });
    render(<PhoneChangeForm onRequestCodes={requestCodes} onVerify={verify} />);

    await user.type(screen.getByLabelText('新手机号'), '13900139000');
    await user.click(screen.getByRole('button', { name: '向两个手机号发送验证码' }));
    expect(screen.getByRole('status')).toHaveTextContent('如果手机号可用');
    expect(screen.getByRole('button', { name: /重新发送/ })).toBeDisabled();

    await user.type(screen.getByLabelText('原手机号验证码'), '000000');
    await user.type(screen.getByLabelText('新手机号验证码'), '111111');
    await user.click(screen.getByRole('button', { name: '确认换绑手机号' }));
    expect(screen.getByRole('alert')).toHaveTextContent('无法完成验证，请检查验证码或稍后重试');
    expect(screen.queryByText(/已注册|未注册|占用/)).toBeNull();
  });

  it('rate limits repeated server-side phone change requests without account disclosure', async () => {
    const context = {
      ownerId: createUuidV7(),
      currentSessionId: createUuidV7(),
      verifiedPhone: '+8613500135000',
    };
    const first = await accountGateway.requestPhoneChangeCodes(
      { newPhoneE164: '+8613400134000', deviceId: 'test-device' },
      { ...context, idempotencyKey: createUuidV7() },
    );
    expect(first).toEqual({ cooldownSeconds: 60, message: '如果手机号可用，验证码将尽快发送。' });
    await expect(
      accountGateway.requestPhoneChangeCodes(
        { newPhoneE164: '+8613300133000', deviceId: 'test-device' },
        { ...context, idempotencyKey: createUuidV7() },
      ),
    ).rejects.toThrow('RATE_LIMITED');
  });

  it('replays the same phone-code request key during its cooldown', async () => {
    const context = {
      ownerId: createUuidV7(),
      currentSessionId: createUuidV7(),
      verifiedPhone: '+8613500135000',
      idempotencyKey: createUuidV7(),
    };
    const input = { newPhoneE164: '+8613400134000', deviceId: 'test-device' };

    const first = await accountGateway.requestPhoneChangeCodes(input, context);
    await expect(accountGateway.requestPhoneChangeCodes(input, context)).resolves.toEqual(first);
  });

  it('replays a completed phone change after the session phone has rotated', async () => {
    const oldPhone = '+8613500135000';
    const newPhone = '+8613400134000';
    const ownerId = await resolveOrCreateMockSubjectForVerifiedPhone(oldPhone);
    const base = { ownerId, currentSessionId: createUuidV7(), verifiedPhone: oldPhone };
    await accountGateway.requestPhoneChangeCodes(
      { newPhoneE164: newPhone, deviceId: 'test-device' },
      { ...base, idempotencyKey: createUuidV7() },
    );
    const idempotencyKey = createUuidV7();
    const input = {
      currentPhoneCode: '123456',
      newPhoneE164: newPhone,
      newPhoneCode: '123456',
      operationId: idempotencyKey,
    };

    const first = await accountGateway.verifyPhoneChange(input, { ...base, idempotencyKey });
    await expect(
      accountGateway.verifyPhoneChange(input, {
        ...base,
        verifiedPhone: newPhone,
        idempotencyKey,
      }),
    ).resolves.toEqual(first);
  });

  it('requires the exact deletion phrase before the second confirmation', async () => {
    const user = userEvent.setup();
    const closeAccount = vi.fn().mockResolvedValue(ok({ closed: true }));
    render(<AccountDeletion onDelete={closeAccount} cooldownSeconds={0} />);

    const continueButton = screen.getByRole('button', { name: '继续注销' });
    expect(continueButton).toBeDisabled();
    await user.type(screen.getByLabelText('输入确认短语'), '注销');
    expect(continueButton).toBeDisabled();
    await user.clear(screen.getByLabelText('输入确认短语'));
    await user.type(screen.getByLabelText('输入确认短语'), '注销账号');
    await user.type(screen.getByLabelText('短信验证码'), '123456');
    expect(continueButton).toBeEnabled();

    await user.click(continueButton);
    expect(closeAccount).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('作品访问和未完成服务将受到影响');
  });

  it('traps focus inside destructive confirmation dialogs', async () => {
    const user = userEvent.setup();
    render(<AccountDeletion onDelete={vi.fn()} cooldownSeconds={0} />);
    await user.type(screen.getByLabelText('输入确认短语'), '注销账号');
    await user.type(screen.getByLabelText('短信验证码'), '123456');
    await user.click(screen.getByRole('button', { name: '继续注销' }));

    const confirm = screen.getByRole('button', { name: '永久注销账号' });
    const cancel = screen.getByRole('button', { name: '暂不注销' });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(confirm, { key: 'Tab' });
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: 'Tab' });
    expect(confirm).toHaveFocus();
  });
});
