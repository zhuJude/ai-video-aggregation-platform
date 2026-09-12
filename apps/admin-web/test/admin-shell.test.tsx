/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/require-await -- Vitest asymmetric matchers are typed as any; async fakes implement production port signatures. */

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { AdminShell } from '../components/admin-shell';
import { LoginPanel } from '../components/login-panel';
import {
  publicPasswordStepResult,
  validateTotpInput,
} from '../lib/login-flow';
import {
  AuthorizationError,
  signAdminSession,
} from '../lib/session-auth';

const allAdminPermissions = [
  '*', 'audit:read', 'content:read', 'finance:read', 'iam:read', 'models:read',
  'overview:read', 'pricing:read', 'providers:read', 'routing:read', 'system:read',
  'tasks:read', 'tickets:read', 'users:export', 'users:phone-exact', 'users:read',
  'users:refresh', 'users:status', 'wallet:adjust',
] as const;
const traceIdPattern = /^[0-9a-f]{32}$/u;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function equivalentNonCanonicalSegment(value: string): string | undefined {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const decode = (candidate: string) => atob(candidate.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(candidate.length / 4) * 4, '='));
  const expected = decode(value);
  for (const character of alphabet) {
    const candidate = `${value.slice(0, -1)}${character}`;
    if (candidate !== value && decode(candidate) === expected) return candidate;
  }
  return undefined;
}
import {
  requireAdminPermission,
  requireAdminScopedPermission,
} from '../lib/server-guard';
import { config, proxy } from '../proxy';
import {
  type AdminAuthPort,
  type ServerCookiePort,
  createLoginActionHandlers,
} from '../lib/admin-auth-actions';
import { createHttpAdminAuthPort } from '../lib/http-admin-auth-port';
import { normalizeAdminLoginReturnTarget } from '../lib/admin-return-target';
import {
  ADMIN_MFA_CHALLENGE_COOKIE,
  ADMIN_MFA_CHALLENGE_TTL_MS,
  ADMIN_SESSION_COOKIE,
  isValidAdminMfaChallengeId,
  signAdminMfaChallenge,
  verifyAdminSession,
  verifyAdminMfaChallenge,
} from '../lib/session-auth';

describe('AdminShell', () => {
  it('hides finance navigation without finance permission', () => {
    render(
      <AdminShell subject={{ permissions: ['users:read'], dataScope: 'ALL' }}>
        {null}
      </AdminShell>,
    );

    expect(screen.queryByRole('link', { name: '财务' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: '用户' })).toBeVisible();
  });

  it('renders the exact operations navigation for a fully authorized subject', () => {
    render(
      <AdminShell subject={{ permissions: ['*'], dataScope: 'ALL' }}>
        {null}
      </AdminShell>,
    );

    expect(
      screen.getAllByRole('link').map((link) => link.textContent),
    ).toEqual([
      '总览',
      '用户',
      '供应商',
      '模型能力',
      '定价',
      '路由',
      '任务',
      '财务',
      '内容运营',
      '工单',
      '后台权限',
      '审计',
      '系统运行',
    ]);
    expect(screen.getByRole('link', { name: '定价' })).toHaveAttribute(
      'href',
      '/pricing',
    );
    expect(screen.getByRole('link', { name: '路由' })).toHaveAttribute(
      'href',
      '/routing',
    );
  });

  it('shows the admin identity, command search, breadcrumbs and environment', () => {
    render(
      <AdminShell
        breadcrumbs={[
          { label: '用户', href: '/users' },
          { label: '账户详情', href: '/users/0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' },
        ]}
        environment="预发布"
        subject={{ permissions: ['users:read'], dataScope: 'ASSIGNED' }}
      >
        {null}
      </AdminShell>,
    );

    expect(screen.getByText('镜界运营控制台')).toBeVisible();
    expect(screen.getByText('admin.ai-video.internal')).toBeVisible();
    expect(screen.getByRole('combobox', { name: '命令搜索' })).toBeVisible();
    expect(screen.getByRole('navigation', { name: '面包屑' })).toHaveTextContent(
      '用户账户详情',
    );
    expect(screen.getAllByText('预发布')).toHaveLength(2);
    expect(screen.getAllByText('数据范围 已分配')).toHaveLength(2);
  });

  it('hides unauthorized actions and never renders session tokens', () => {
    const subject = {
      permissions: ['users:read'],
      dataScope: 'OWN' as const,
      sessionToken: 'sensitive-session-token',
    };

    const { container } = render(
      <AdminShell
        actions={[
          { label: '刷新', permission: 'users:read' },
          { label: '导出', permission: 'users:export' },
        ]}
        subject={subject}
      >
        {null}
      </AdminShell>,
    );

    expect(screen.getByRole('button', { name: '刷新' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '导出' })).not.toBeInTheDocument();
    expect(screen.getAllByText('数据范围 本人负责')).toHaveLength(2);
    expect(container).not.toHaveTextContent('sensitive-session-token');
  });

  it('filters command links from permitted navigation without leaking unauthorized routes', () => {
    render(
      <AdminShell subject={{ permissions: ['users:read'], dataScope: 'OWN' }}>
        {null}
      </AdminShell>,
    );
    const search = screen.getByRole('combobox', { name: '命令搜索' });

    fireEvent.change(search, { target: { value: '用户' } });
    const permittedResults = screen.getByRole('listbox', {
      name: '命令搜索结果',
    });
    expect(
      within(permittedResults).getByRole('link', { name: '用户' }),
    ).toHaveAttribute('href', '/users');

    fireEvent.change(search, { target: { value: '财务' } });
    const restrictedResults = screen.getByRole('listbox', {
      name: '命令搜索结果',
    });
    expect(
      within(restrictedResults).queryByRole('link', { name: '财务' }),
    ).not.toBeInTheDocument();
    expect(within(restrictedResults).getByText('没有可用命令')).toBeVisible();
  });

  it('uses one brand without a duplicate mobile identity', () => {
    render(
      <AdminShell subject={{ permissions: ['overview:read'], dataScope: 'ALL' }}>
        {null}
      </AdminShell>,
    );

    expect(
      screen.getAllByText(/^(?:镜界)?运营控制台$/),
    ).toHaveLength(1);
  });
});

describe('MFA login', () => {
  it('accepts only local non-sensitive admin return targets', () => {
    expect(
      normalizeAdminLoginReturnTarget(
        '/tasks?cursor=next_1&query=failed-job&status=FAILED',
      ),
    ).toBe('/tasks?cursor=next_1&query=failed-job&status=FAILED');
    expect(normalizeAdminLoginReturnTarget('https://evil.example/tasks')).toBeUndefined();
    expect(normalizeAdminLoginReturnTarget('//evil.example/tasks')).toBeUndefined();
    expect(normalizeAdminLoginReturnTarget('/tasks?query=13800138000')).toBeUndefined();
    expect(normalizeAdminLoginReturnTarget('/login')).toBeUndefined();
  });

  it('delivers a server preflight cookie before enabling the credential POST', async () => {
    let release: (() => void) | undefined;
    const preflightAction = vi.fn(() => new Promise<{ status: 'READY' }>((resolve) => { release = () => { resolve({ status: 'READY' }); }; }));
    const passwordAction = vi.fn(async (
      _previousState: ReturnType<typeof publicPasswordStepResult> | null,
      _formData: FormData,
    ) => {
      void _previousState;
      void _formData;
      return publicPasswordStepResult();
    });
    render(<LoginPanel passwordAction={passwordAction} preflightAction={preflightAction} totpAction={async () => ({ status: 'INVALID_TOTP', message: '验证失败，请重试', cooldownSeconds: 0 })} />);
    fireEvent.change(screen.getByLabelText(/管理员账号/), { target: { value: 'operator@example.invalid' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
    const passwordFormElement = screen.getByLabelText(/密码/).closest('form');
    if (!passwordFormElement) throw new Error('Missing password form');
    fireEvent.submit(passwordFormElement);
    expect(passwordAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '准备安全登录' }));
    expect(preflightAction).toHaveBeenCalledWith('operator@example.invalid');
    expect(passwordAction).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '正在建立安全登录' })).toBeDisabled();
    release?.();
    await screen.findByRole('button', { name: '继续验证' });
    fireEvent.click(screen.getByRole('button', { name: '继续验证' }));
    await waitFor(() => { expect(passwordAction).toHaveBeenCalledOnce(); });
  });

  it('serializes preflights and ignores a stale identifier result before credential submission', async () => {
    const pending: Array<{
      identifier: string;
      resolve: (result: { status: 'READY' }) => void;
    }> = [];
    const preflightAction = vi.fn((identifier: string) => new Promise<{ status: 'READY' }>((resolve) => {
      pending.push({ identifier, resolve });
    }));
    const passwordAction = vi.fn(async (
      _previousState: ReturnType<typeof publicPasswordStepResult> | null,
      _formData: FormData,
    ) => {
      void _previousState;
      void _formData;
      return publicPasswordStepResult();
    });
    render(<LoginPanel passwordAction={passwordAction} preflightAction={preflightAction} totpAction={async () => ({ status: 'INVALID_TOTP', message: '验证失败，请重试', cooldownSeconds: 0 })} />);

    const identifierInput = screen.getByLabelText(/管理员账号/);
    fireEvent.change(identifierInput, { target: { value: 'first@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: '准备安全登录' }));
    fireEvent.click(screen.getByRole('button', { name: '正在建立安全登录' }));
    expect(preflightAction).toHaveBeenCalledTimes(1);

    fireEvent.change(identifierInput, { target: { value: ' second@example.invalid ' } });
    await act(async () => { pending[0]?.resolve({ status: 'READY' }); });
    await waitFor(() => { expect(preflightAction).toHaveBeenCalledWith('second@example.invalid'); });
    expect(screen.queryByRole('button', { name: '继续验证' })).not.toBeInTheDocument();

    await act(async () => { pending[1]?.resolve({ status: 'READY' }); });
    await screen.findByRole('button', { name: '继续验证' });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '继续验证' }));
    await waitFor(() => { expect(passwordAction).toHaveBeenCalledOnce(); });
    const submitted = passwordAction.mock.calls[0]?.[1];
    expect(submitted?.get('identifier')).toBe('second@example.invalid');
  });

  it('keeps a password action failure on the password step with an accessible error', async () => {
    render(<LoginPanel
      passwordAction={async () => ({ step: 'password', message: '无法建立安全登录，请重试' })}
      preflightAction={async () => ({ status: 'READY' })}
      totpAction={async () => ({ status: 'INVALID_TOTP', message: '验证失败，请重试', cooldownSeconds: 0 })}
    />);
    fireEvent.change(screen.getByLabelText(/管理员账号/), { target: { value: 'operator@example.invalid' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '准备安全登录' }));
    await screen.findByRole('button', { name: '继续验证' });
    fireEvent.click(screen.getByRole('button', { name: '继续验证' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('无法建立安全登录，请重试');
    expect(screen.getByText('管理员登录')).toBeVisible();
  });

  it('invalidates readiness and lets the same identifier recover after a local preflight failure', async () => {
    const preflightAction = vi.fn(async () => ({ status: 'READY' as const }));
    const passwordAction = vi.fn(async () => ({
      step: 'password' as const,
      message: '无法建立安全登录，请重试',
      requiresPreflight: true as const,
    }));
    render(<LoginPanel
      passwordAction={passwordAction}
      preflightAction={preflightAction}
      totpAction={async () => ({ status: 'INVALID_TOTP', message: '验证失败，请重试', cooldownSeconds: 0 })}
    />);
    fireEvent.change(screen.getByLabelText(/管理员账号/), { target: { value: 'operator@example.invalid' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '准备安全登录' }));
    await screen.findByRole('button', { name: '继续验证' });
    fireEvent.click(screen.getByRole('button', { name: '继续验证' }));

    await screen.findByRole('button', { name: '重新建立安全登录' });
    expect(screen.getByText('管理员登录')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '重新建立安全登录' }));
    await waitFor(() => { expect(preflightAction).toHaveBeenCalledTimes(2); });
    await screen.findByRole('button', { name: '继续验证' });
  });

  it('keeps a delivered preflight ready after an indeterminate password failure', async () => {
    render(<LoginPanel
      passwordAction={async () => ({ step: 'password', message: '无法建立安全登录，请重试' })}
      preflightAction={async () => ({ status: 'READY' })}
      totpAction={async () => ({ status: 'INVALID_TOTP', message: '验证失败，请重试', cooldownSeconds: 0 })}
    />);
    fireEvent.change(screen.getByLabelText(/管理员账号/), { target: { value: 'operator@example.invalid' } });
    fireEvent.change(screen.getByLabelText(/密码/), { target: { value: 'secret' } });
    fireEvent.click(screen.getByRole('button', { name: '准备安全登录' }));
    await screen.findByRole('button', { name: '继续验证' });
    fireEvent.click(screen.getByRole('button', { name: '继续验证' }));
    await waitFor(() => { expect(screen.getByRole('button', { name: '继续验证' })).toBeEnabled(); });
  });

  it('returns a password response with no credential-validity input', () => {
    expect(publicPasswordStepResult().message).not.toMatch(
      /账户不存在|用户未找到/,
    );
  });

  it.each(['12345', '1234567', '12a456', '１２３４５６', ' 123456 '])(
    'rejects a TOTP value that is not exactly six ASCII digits: %s',
    (value) => {
      expect(validateTotpInput(value)).toEqual({
        ok: false,
        message: '请输入 6 位数字验证码',
      });
    },
  );

  it('accepts exactly six ASCII digits', () => {
    expect(validateTotpInput('042731')).toEqual({ ok: true, code: '042731' });
  });

  it('drives the TOTP cooldown UI only from server action state', async () => {
    const passwordAction = async () => publicPasswordStepResult();
    const totpAction = async () => ({
      status: 'LOCKED' as const,
      message: '请在 43 秒后重试',
      cooldownSeconds: 43,
    });
    render(
      <LoginPanel
        passwordAction={passwordAction}
        preflightAction={async () => ({ status: 'READY' })}
        totpAction={totpAction}
      />,
    );

    fireEvent.change(screen.getByLabelText(/管理员账号/), {
      target: { value: 'operator@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/密码/), {
      target: { value: 'not-a-real-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: '准备安全登录' }));
    await screen.findByRole('button', { name: '继续验证' });
    fireEvent.click(screen.getByRole('button', { name: '继续验证' }));

    const totpInput = await screen.findByLabelText('六位验证码');
    fireEvent.change(totpInput, { target: { value: '042731' } });
    fireEvent.click(screen.getByRole('button', { name: '验证并登录' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent('请在 43 秒后重试');
    });
    expect(screen.getByLabelText('六位验证码')).toBeDisabled();
    expect(screen.getByRole('button', { name: '验证并登录' })).toBeDisabled();
  });
});

describe('server-backed MFA actions', () => {
  const challengeSigningKey = 'challenge-signing-key-at-least-32-bytes';
  const sessionSigningKey = 'session-signing-key-at-least-32-bytes';
  const now = 1_800_000_000_000;

  function createCookiePort(): ServerCookiePort & {
    values: Map<string, string>;
    writes: Array<{
      name: string;
      value: string;
      options: Parameters<ServerCookiePort['set']>[2];
    }>;
  } {
    const values = new Map<string, string>();
    const writes: Array<{
      name: string;
      value: string;
      options: Parameters<ServerCookiePort['set']>[2];
    }> = [];

    return {
      values,
      writes,
      get(name) {
        return values.get(name);
      },
      set(name, value, options) {
        values.set(name, value);
        writes.push({ name, value, options });
      },
      delete(name) {
        values.delete(name);
      },
    };
  }

  function passwordForm(): FormData {
    const formData = new FormData();
    formData.set('identifier', 'operator@example.invalid');
    formData.set('password', 'not-a-real-password');
    return formData;
  }

  function totpForm(code: string): FormData {
    const formData = new FormData();
    formData.set('totp', code);
    return formData;
  }

  it('advances only a valid authoritative password challenge', async () => {
    const acceptedCookies = createCookiePort();
    const rejectedCookies = createCookiePort();
    const acceptedPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'A'.repeat(43),
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };
    const rejectedPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'too-short',
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };

    const accepted = createLoginActionHandlers({
      authPort: acceptedPort,
      cookies: acceptedCookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });
    const rejected = createLoginActionHandlers({
      authPort: rejectedPort,
      cookies: rejectedCookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });

    await expect(accepted.submitPassword(passwordForm())).resolves.toEqual(publicPasswordStepResult());
    await expect(rejected.submitPassword(passwordForm())).resolves.toEqual({ step: 'password', message: '无法建立安全登录，请重试' });
    expect(acceptedCookies.writes).toHaveLength(1);
    expect(acceptedCookies.writes[0]).toMatchObject({
      name: ADMIN_MFA_CHALLENGE_COOKIE,
      options: { httpOnly: true, maxAge: 600, sameSite: 'strict', secure: true },
    });
    expect(rejectedCookies.writes).toHaveLength(1);
    await expect(verifyAdminMfaChallenge(acceptedCookies.get(ADMIN_MFA_CHALLENGE_COOKIE), challengeSigningKey, now)).resolves.toMatchObject({ stage: 'TOTP' });
    await expect(verifyAdminMfaChallenge(rejectedCookies.get(ADMIN_MFA_CHALLENGE_COOKIE), challengeSigningKey, now)).resolves.toMatchObject({ stage: 'PASSWORD' });
  });

  it('returns a fixed-shape decoy with the same password message when the auth port is unavailable', async () => {
    const cookies = createCookiePort();
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        throw new Error('IAM unavailable');
      },
      async verifyTotp() {
        throw new Error('IAM unavailable');
      },
    };
    const actions = createLoginActionHandlers({
      authPort,
      cookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });

    await expect(actions.submitPassword(passwordForm())).resolves.toEqual({ step: 'password', message: '无法建立安全登录，请重试' });
    expect(cookies.writes).toHaveLength(1);
    expect(cookies.writes[0]).toMatchObject({
      name: ADMIN_MFA_CHALLENGE_COOKIE,
      options: {
        httpOnly: true,
        maxAge: 600,
        sameSite: 'strict',
        secure: true,
      },
    });
    const claims = await verifyAdminMfaChallenge(
      cookies.get(ADMIN_MFA_CHALLENGE_COOKIE),
      challengeSigningKey,
      now,
    );
    expect(claims).toMatchObject({ stage: 'PASSWORD' });
    expect(claims).not.toHaveProperty('challengeId');

    await expect(actions.submitTotp(totpForm('042731'))).resolves.toEqual({
      status: 'INVALID_TOTP',
      message: '验证失败，请重试',
      cooldownSeconds: 0,
    });
  });

  it('validates TOTP format on the server before calling the auth port', async () => {
    let verificationCalls = 0;
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'unused-format-challenge',
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        verificationCalls += 1;
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };
    const actions = createLoginActionHandlers({
      authPort,
      cookies: createCookiePort(),
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });

    await expect(actions.submitTotp(totpForm('12a456'))).resolves.toMatchObject({
      status: 'INVALID_TOTP',
    });
    expect(verificationCalls).toBe(0);
  });

  it('enforces IAM cooldown state and rejects attempts during cooldown', async () => {
    const cookies = createCookiePort();
    let verificationCalls = 0;
    const commandKeys: Array<string | undefined> = [];
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'A'.repeat(43),
          expiresAt: now + 600_000,
        };
      },
      async verifyTotp(input) {
        commandKeys.push(input.idempotencyKey);
        verificationCalls += 1;
        return verificationCalls >= 3
          ? {
              kind: 'REJECTED',
              attemptsRemaining: 0,
              lockedUntil: now + 60_000,
            }
          : {
              kind: 'REJECTED',
              attemptsRemaining: 3 - verificationCalls,
            };
      },
    };
    const actions = createLoginActionHandlers({
      authPort,
      cookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });
    await actions.submitPassword(passwordForm());

    await actions.submitTotp(totpForm('000001'));
    await actions.submitTotp(totpForm('000002'));
    const locked = await actions.submitTotp(totpForm('000003'));
    const rejectedDuringCooldown = await actions.submitTotp(totpForm('000004'));

    expect(locked).toMatchObject({ status: 'LOCKED', cooldownSeconds: 60 });
    expect(rejectedDuringCooldown).toMatchObject({
      status: 'LOCKED',
      cooldownSeconds: 60,
    });
    expect(verificationCalls).toBe(4);
    expect(new Set(commandKeys).size).toBe(4);
  });

  it('keeps IAM cooldown authoritative when an old challenge cookie is replayed', async () => {
    const cookies = createCookiePort();
    let failures = 0;
    const authPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'A'.repeat(43),
          expiresAt: now + 600_000,
        };
      },
      async verifyTotp() {
        failures += 1;
        return failures >= 3
          ? {
              kind: 'REJECTED' as const,
              attemptsRemaining: 0,
              lockedUntil: now + 60_000,
            }
          : {
              kind: 'REJECTED' as const,
              attemptsRemaining: 3 - failures,
            };
      },
    } as AdminAuthPort;
    const actions = createLoginActionHandlers({
      authPort,
      cookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });
    await actions.submitPassword(passwordForm());
    const originalCookie = cookies.get(ADMIN_MFA_CHALLENGE_COOKIE);

    await actions.submitTotp(totpForm('000001'));
    await actions.submitTotp(totpForm('000002'));
    await actions.submitTotp(totpForm('000003'));
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, originalCookie ?? '');

    await expect(actions.submitTotp(totpForm('000004'))).resolves.toMatchObject({
      status: 'LOCKED',
      cooldownSeconds: 60,
    });
    expect(failures).toBe(4);
  });

  it('stores exact stage-specific claims for accepted and malformed password outcomes', async () => {
    const acceptedCookies = createCookiePort();
    const decoyCookies = createCookiePort();
    const acceptedPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'A'.repeat(43),
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };
    const decoyPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'invalid-id',
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };
    const accepted = createLoginActionHandlers({
      authPort: acceptedPort,
      cookies: acceptedCookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });
    const decoy = createLoginActionHandlers({
      authPort: decoyPort,
      cookies: decoyCookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });

    const acceptedResult = await accepted.submitPassword(passwordForm());
    const decoyResult = await decoy.submitPassword(passwordForm());

    expect(acceptedResult).toEqual(publicPasswordStepResult());
    expect(decoyResult).toEqual({ step: 'password', message: '无法建立安全登录，请重试' });
    expect(decoyCookies.writes).toHaveLength(acceptedCookies.writes.length);
    expect(decoyCookies.writes[0]?.options).toEqual(
      acceptedCookies.writes[0]?.options,
    );
    const acceptedClaims = await verifyAdminMfaChallenge(
      acceptedCookies.get(ADMIN_MFA_CHALLENGE_COOKIE),
      challengeSigningKey,
      now,
    );
    const decoyClaims = await verifyAdminMfaChallenge(
      decoyCookies.get(ADMIN_MFA_CHALLENGE_COOKIE),
      challengeSigningKey,
      now,
    );
    expect(Object.keys(acceptedClaims ?? {}).sort()).toEqual([
      'audience',
      'challengeId',
      'correlationId',
      'expiresAt',
      'identifierBinding',
      'redirectTo',
      'seed',
      'stage',
      'version',
    ]);
    expect(Object.keys(decoyClaims ?? {}).sort()).toEqual([
      'audience',
      'correlationId',
      'expiresAt',
      'identifierBinding',
      'redirectTo',
      'seed',
      'stage',
      'version',
    ]);
    expect(acceptedClaims?.expiresAt).toBe(now + 600_000);
    expect(decoyClaims?.expiresAt).toBe(now + 600_000);
  });

  it('uses the same TOTP failure for real, decoy, expired, and missing challenges', async () => {
    const realCookies = createCookiePort();
    const decoyCookies = createCookiePort();
    const expiredCookies = createCookiePort();
    const noChallengeCookies = createCookiePort();
    const realPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'A'.repeat(43),
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };
    const decoyPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'A'.repeat(43),
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };
    const real = createLoginActionHandlers({
      authPort: realPort,
      cookies: realCookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });
    const decoy = createLoginActionHandlers({
      authPort: decoyPort,
      cookies: decoyCookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });
    const expired = createLoginActionHandlers({
      authPort: realPort,
      cookies: expiredCookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });
    const missing = createLoginActionHandlers({
      authPort: realPort,
      cookies: noChallengeCookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
    });
    await real.submitPassword(passwordForm());
    await decoy.submitPassword(passwordForm());
    expiredCookies.values.set(
      ADMIN_MFA_CHALLENGE_COOKIE,
      await signAdminMfaChallenge(
        { audience: 'admin-mfa', challengeId: 'A'.repeat(43), correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', expiresAt: now - 1, identifierBinding: 'A'.repeat(43), seed: 'A'.repeat(43), stage: 'TOTP', version: 1 },
        challengeSigningKey,
      ),
    );

    const realFailure = await real.submitTotp(totpForm('000001'));
    const decoyFailure = await decoy.submitTotp(totpForm('000001'));
    const expiredFailure = await expired.submitTotp(totpForm('000001'));
    const missingFailure = await missing.submitTotp(totpForm('000001'));

    expect(decoyFailure).toEqual(realFailure);
    expect(expiredFailure).toEqual(realFailure);
    expect(missingFailure).toEqual(realFailure);
  });

  it('issues only an HttpOnly session cookie and clears challenge state on success', async () => {
    const cookies = createCookiePort();
    const redirectTo = '/tasks?cursor=next_1&query=failed-job&status=FAILED';
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'A'.repeat(43),
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        return {
          kind: 'AUTHENTICATED',
          subject: {
            subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
            permissions: ['overview:read'],
            dataScope: 'OWN',
          },
          expiresAt: now + 3_600_000,
        };
      },
    };
    const actions = createLoginActionHandlers({
      authPort,
      cookies,
      challengeSigningKey,
      sessionSigningKey,
      now: () => now,
      createSessionInstanceId: () => '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      redirectTo,
    });
    await actions.submitPassword(passwordForm());

    const result = await actions.submitTotp(totpForm('042731'));

    expect(result).toEqual({ status: 'AUTHENTICATED', redirectTo });
    expect(result).not.toHaveProperty('sessionToken');
    expect(cookies.get(ADMIN_MFA_CHALLENGE_COOKIE)).toBeUndefined();
    expect(cookies.writes.at(-1)).toMatchObject({
      name: ADMIN_SESSION_COOKIE,
      options: { httpOnly: true, sameSite: 'strict', secure: true },
    });
    await expect(verifyAdminSession(cookies.get(ADMIN_SESSION_COOKIE), sessionSigningKey, now)).resolves.toMatchObject({ sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f' });
  });

  it('issues a fresh random session instance for each independent MFA login', async () => {
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() { return { challengeId: 'A'.repeat(43), expiresAt: now + 120_000 }; },
      async verifyTotp() { return { kind: 'AUTHENTICATED', subject: { dataScope: 'OWN', permissions: ['overview:read'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }, expiresAt: now + 3_600_000 }; },
    };
    const issue = async (sessionInstanceId: string) => {
      const cookiePort = createCookiePort();
      const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies: cookiePort, createSessionInstanceId: () => sessionInstanceId, now: () => now, sessionSigningKey });
      await actions.submitPassword(passwordForm());
      await actions.submitTotp(totpForm('042731'));
      return verifyAdminSession(cookiePort.get(ADMIN_SESSION_COOKIE), sessionSigningKey, now);
    };
    const first = await issue('0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f');
    const second = await issue('0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f');
    expect(first?.sessionInstanceId).not.toBe(second?.sessionInstanceId);
  });

  it('binds stable retry intents and rotating rejected TOTP intents to one signed MFA flow', async () => {
    const cookies = createCookiePort();
    const passwordInputs: Array<Parameters<AdminAuthPort['beginPasswordChallenge']>[0]> = [];
    const totpInputs: Array<Parameters<AdminAuthPort['verifyTotp']>[0]> = [];
    let passwordCalls = 0;
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge(input) {
        passwordInputs.push(input);
        passwordCalls += 1;
        if (passwordCalls === 1) throw new Error('response lost');
        return { challengeId: 'A'.repeat(43), expiresAt: now + 120_000 };
      },
      async verifyTotp(input) {
        totpInputs.push(input);
        return { kind: 'REJECTED', attemptsRemaining: 4 };
      },
    };
    const ids = [
      '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
      '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f',
      '0198f7a4-c6dc-7b39-8a4e-73af0c1d2e3f',
      '0198f7a4-c6dd-7b39-8a4e-73af0c1d2e3f',
    ];
    const actions = createLoginActionHandlers({
      authPort,
      challengeSigningKey,
      cookies,
      createFlowId: () => ids.shift() ?? (() => { throw new Error('unexpected id'); })(),
      now: () => now,
      sessionSigningKey,
    });

    await actions.submitPassword(passwordForm());
    await actions.submitPassword(passwordForm());
    expect(passwordInputs[1]?.correlationId).toBe(passwordInputs[0]?.correlationId);
    expect(passwordInputs[1]?.idempotencyKey).toBe(passwordInputs[0]?.idempotencyKey);

    await actions.submitTotp(totpForm('000001'));
    await actions.submitTotp(totpForm('000002'));
    expect(totpInputs[0]?.correlationId).toBe(passwordInputs[0]?.correlationId);
    expect(totpInputs[1]?.correlationId).toBe(passwordInputs[0]?.correlationId);
    expect(totpInputs[1]?.idempotencyKey).not.toBe(totpInputs[0]?.idempotencyKey);
    const claims = await verifyAdminMfaChallenge(cookies.get(ADMIN_MFA_CHALLENGE_COOKIE), challengeSigningKey, now);
    expect(claims).toMatchObject({ correlationId: passwordInputs[0]?.correlationId });
  });

  it('rotates the password intent only after an authoritative denial', async () => {
    const cookies = createCookiePort();
    const inputs: Array<Parameters<AdminAuthPort['beginPasswordChallenge']>[0]> = [];
    const ids = ['0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f', '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f', '0198f7a4-c6dc-7b39-8a4e-73af0c1d2e3f'];
    const actions = createLoginActionHandlers({
      authPort: { async beginPasswordChallenge(input) { inputs.push(input); return { challengeId: 'A'.repeat(43), expiresAt: now + 120_000, rotateIntent: true }; }, async verifyTotp() { return { kind: 'REJECTED', attemptsRemaining: 4 }; } },
      challengeSigningKey,
      cookies,
      createFlowId: () => ids.shift() ?? (() => { throw new Error('unexpected id'); })(),
      now: () => now,
      sessionSigningKey,
    });
    await actions.submitPassword(passwordForm());
    await actions.submitPassword(passwordForm());
    expect(inputs[1]?.correlationId).toBe(inputs[0]?.correlationId);
    expect(inputs[1]?.idempotencyKey).not.toBe(inputs[0]?.idempotencyKey);
  });

  it('requires a delivered PASSWORD preflight and derives stable credential-specific command keys', async () => {
    const cookies = createCookiePort();
    const passwordInputs: Array<Parameters<AdminAuthPort['beginPasswordChallenge']>[0]> = [];
    const totpInputs: Array<Parameters<AdminAuthPort['verifyTotp']>[0]> = [];
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge(input) { passwordInputs.push(input); return { challengeId: 'A'.repeat(43), expiresAt: now + 120_000 }; },
      async verifyTotp(input) { totpInputs.push(input); throw new Error('response lost'); },
    };
    const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies, now: () => now, requirePreflight: true, sessionSigningKey });
    await expect(actions.submitPassword(passwordForm())).resolves.toEqual({
      step: 'password',
      message: '无法建立安全登录，请重试',
      requiresPreflight: true,
    });
    expect(passwordInputs).toHaveLength(0);
    await expect(actions.preparePassword('operator@example.invalid')).resolves.toEqual({ status: 'READY' });
    const deliveredPasswordCookie = cookies.get(ADMIN_MFA_CHALLENGE_COOKIE) ?? '';
    const passwordClaims = await verifyAdminMfaChallenge(deliveredPasswordCookie, challengeSigningKey, now);
    expect(passwordClaims).toMatchObject({ audience: 'admin-mfa', stage: 'PASSWORD', version: 1 });
    expect(deliveredPasswordCookie).not.toMatch(/not-a-real-password|operator@example.invalid/u);

    await actions.submitPassword(passwordForm());
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, deliveredPasswordCookie);
    await actions.submitPassword(passwordForm());
    expect(passwordInputs[1]?.idempotencyKey).toBe(passwordInputs[0]?.idempotencyKey);
    expect(passwordInputs[1]?.correlationId).toBe(passwordInputs[0]?.correlationId);

    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, deliveredPasswordCookie);
    const changedPassword = passwordForm(); changedPassword.set('password', 'different-password');
    await actions.submitPassword(changedPassword);
    expect(passwordInputs[2]?.idempotencyKey).not.toBe(passwordInputs[0]?.idempotencyKey);
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, deliveredPasswordCookie);
    const changedIdentifier = passwordForm(); changedIdentifier.set('identifier', 'other@example.invalid');
    await expect(actions.submitPassword(changedIdentifier)).resolves.toEqual({ step: 'password', message: '无法建立安全登录，请重试', requiresPreflight: true });
    expect(passwordInputs).toHaveLength(3);

    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, deliveredPasswordCookie);
    await actions.submitPassword(passwordForm());
    const deliveredTotpCookie = cookies.get(ADMIN_MFA_CHALLENGE_COOKIE) ?? '';
    await actions.submitTotp(totpForm('111111'));
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, deliveredTotpCookie);
    await actions.submitTotp(totpForm('111111'));
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, deliveredTotpCookie);
    await actions.submitTotp(totpForm('222222'));
    expect(totpInputs[1]?.idempotencyKey).toBe(totpInputs[0]?.idempotencyKey);
    expect(totpInputs[2]?.idempotencyKey).not.toBe(totpInputs[0]?.idempotencyKey);
    expect(totpInputs.every((input) => input.correlationId === passwordInputs[0]?.correlationId)).toBe(true);
  });

  it('requires preflight recovery for tampered, expired, and wrong-stage local cookies without calling IAM', async () => {
    let iamCalls = 0;
    const cookies = createCookiePort();
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() { iamCalls += 1; return { challengeId: 'A'.repeat(43), expiresAt: now + 120_000 }; },
      async verifyTotp() { throw new Error('not used'); },
    };
    const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies, now: () => now, requirePreflight: true, sessionSigningKey });
    await actions.preparePassword('operator@example.invalid');
    const delivered = cookies.get(ADMIN_MFA_CHALLENGE_COOKIE) ?? '';
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, `${delivered}x`);
    await expect(actions.submitPassword(passwordForm())).resolves.toMatchObject({ step: 'password', requiresPreflight: true });

    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, await signAdminMfaChallenge({
      audience: 'admin-mfa', correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', expiresAt: now - 1,
      identifierBinding: 'A'.repeat(43), seed: 'A'.repeat(43), stage: 'PASSWORD', version: 1,
    }, challengeSigningKey));
    await expect(actions.submitPassword(passwordForm())).resolves.toMatchObject({ step: 'password', requiresPreflight: true });

    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, await signAdminMfaChallenge({
      audience: 'admin-mfa', challengeId: 'A'.repeat(43), correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', expiresAt: now + 60_000,
      identifierBinding: 'A'.repeat(43), seed: 'A'.repeat(43), stage: 'TOTP', version: 1,
    }, challengeSigningKey));
    await expect(actions.submitPassword(passwordForm())).resolves.toMatchObject({ step: 'password', requiresPreflight: true });
    expect(iamCalls).toBe(0);
  });

  it.each([
    ['malformed JSON', async () => new Response('{', { status: 200 }), 'MALFORMED_RESPONSE'],
    ['malformed schema', async () => Response.json({ challengeId: 'bad', expiresInSeconds: 600 }), 'MALFORMED_RESPONSE'],
    ['network', async () => Promise.reject(new Error('offline')), 'NETWORK_FAILURE'],
    ['timeout', async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new DOMException('timed out', 'AbortError')); }); }), 'TIMEOUT'],
    ['429', async () => Response.json({}, { status: 429 }), 'UPSTREAM_FAILURE'],
    ['500', async () => Response.json({}, { status: 500 }), 'UPSTREAM_FAILURE'],
  ])('lets the trusted HTTP adapter own exactly one %s password technical event', async (_label, fetchImpl, reason) => {
    const events: unknown[] = [];
    const telemetry = { record(event: unknown) { events.push(event); } };
    const cookies = createCookiePort();
    const authPort = createHttpAdminAuthPort(
      { apiUrl: 'https://iam.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      { deadlineMs: 1, fetchImpl: fetchImpl as typeof fetch, now: () => now, telemetry },
    );
    const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies, now: () => now, requirePreflight: true, sessionSigningKey, telemetry });
    await actions.preparePassword('operator@example.invalid');
    await expect(actions.submitPassword(passwordForm())).resolves.toMatchObject({ step: 'password' });
    expect(events).toEqual([expect.objectContaining({ correlationId: expect.stringMatching(uuidV7Pattern), operation: 'iam.password.begin', reason, traceId: expect.stringMatching(traceIdPattern) })]);
    expect(JSON.stringify(events)).not.toMatch(/operator@example\.invalid|not-a-real-password/u);
  });

  it('records no technical event for a strict password business rejection', async () => {
    const events: unknown[] = [];
    const telemetry = { record(event: unknown) { events.push(event); } };
    const cookies = createCookiePort();
    const authPort = createHttpAdminAuthPort(
      { apiUrl: 'https://iam.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      { fetchImpl: async () => Response.json({ kind: 'REJECTED', reason: 'INVALID_CREDENTIALS' }, { status: 401 }), now: () => now, telemetry },
    );
    const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies, now: () => now, requirePreflight: true, sessionSigningKey, telemetry });
    await actions.preparePassword('operator@example.invalid');
    await actions.submitPassword(passwordForm());
    expect(events).toEqual([]);
  });

  it('records one action-level event for an unclassified password-port exception', async () => {
    const events: unknown[] = [];
    const telemetry = { record(event: unknown) { events.push(event); } };
    const cookies = createCookiePort();
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() { throw Object.assign(new Error('fake failure'), { reason: 'NETWORK_FAILURE' }); },
      async verifyTotp() { throw new Error('not used'); },
    };
    const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies, now: () => now, requirePreflight: true, sessionSigningKey, telemetry });
    await actions.preparePassword('operator@example.invalid');
    await actions.submitPassword(passwordForm());
    expect(events).toEqual([expect.objectContaining({ correlationId: expect.stringMatching(uuidV7Pattern), operation: 'login.password', reason: 'UPSTREAM_FAILURE', traceId: expect.stringMatching(traceIdPattern) })]);
  });

  it.each([
    ['malformed JSON', async () => new Response('{', { status: 200 }), 'MALFORMED_RESPONSE'],
    ['malformed schema', async () => Response.json({ kind: 'CONSUMED', extra: true }), 'MALFORMED_RESPONSE'],
    ['network', async () => Promise.reject(new Error('offline')), 'NETWORK_FAILURE'],
    ['timeout', async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => { init?.signal?.addEventListener('abort', () => { reject(new DOMException('timed out', 'AbortError')); }); }), 'TIMEOUT'],
    ['429', async () => Response.json({}, { status: 429 }), 'UPSTREAM_FAILURE'],
    ['500', async () => Response.json({}, { status: 500 }), 'UPSTREAM_FAILURE'],
  ])('lets the trusted HTTP adapter own exactly one %s TOTP technical event', async (_label, fetchImpl, reason) => {
    const events: unknown[] = [];
    const telemetry = { record(event: unknown) { events.push(event); } };
    const cookies = createCookiePort();
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, await signAdminMfaChallenge({
      audience: 'admin-mfa', challengeId: 'A'.repeat(43), correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', expiresAt: now + 60_000,
      identifierBinding: 'A'.repeat(43), seed: 'A'.repeat(43), stage: 'TOTP', version: 1,
    }, challengeSigningKey));
    const authPort = createHttpAdminAuthPort(
      { apiUrl: 'https://iam.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      { deadlineMs: 1, fetchImpl: fetchImpl as typeof fetch, now: () => now, telemetry },
    );
    const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies, now: () => now, sessionSigningKey, telemetry });
    await expect(actions.submitTotp(totpForm('111111'))).resolves.toMatchObject({ status: 'INVALID_TOTP' });
    expect(events).toEqual([expect.objectContaining({ correlationId: expect.stringMatching(uuidV7Pattern), operation: 'iam.totp.verify', reason, traceId: expect.stringMatching(traceIdPattern) })]);
    expect(JSON.stringify(events)).not.toMatch(/111111|A{16}/u);
  });

  it.each([
    [401, { attemptsRemaining: 2, kind: 'REJECTED', reason: 'INVALID_CODE' }],
    [423, { attemptsRemaining: 0, kind: 'REJECTED', lockedUntil: now + 60_000, reason: 'LOCKED' }],
  ])('records no technical event for strict TOTP business rejection %s', async (status, body) => {
    const events: unknown[] = [];
    const telemetry = { record(event: unknown) { events.push(event); } };
    const cookies = createCookiePort();
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, await signAdminMfaChallenge({
      audience: 'admin-mfa', challengeId: 'A'.repeat(43), correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', expiresAt: now + 60_000,
      identifierBinding: 'A'.repeat(43), seed: 'A'.repeat(43), stage: 'TOTP', version: 1,
    }, challengeSigningKey));
    const authPort = createHttpAdminAuthPort(
      { apiUrl: 'https://iam.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      { fetchImpl: async () => Response.json(body, { status }), now: () => now, telemetry },
    );
    const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies, now: () => now, sessionSigningKey, telemetry });
    await actions.submitTotp(totpForm('111111'));
    expect(events).toEqual([]);
  });

  it.each([new Error('fake failure'), Object.assign(new Error('forged failure'), { reason: 'MALFORMED_RESPONSE' })])('records one action-level event for an unclassified fake-port exception %#', async (failure) => {
    const events: unknown[] = [];
    const telemetry = { record(event: unknown) { events.push(event); } };
    const cookies = createCookiePort();
    cookies.values.set(ADMIN_MFA_CHALLENGE_COOKIE, await signAdminMfaChallenge({
      audience: 'admin-mfa', challengeId: 'A'.repeat(43), correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', expiresAt: now + 60_000,
      identifierBinding: 'A'.repeat(43), seed: 'A'.repeat(43), stage: 'TOTP', version: 1,
    }, challengeSigningKey));
    const authPort: AdminAuthPort = { async beginPasswordChallenge() { throw new Error('not used'); }, async verifyTotp() { throw failure; } };
    const actions = createLoginActionHandlers({ authPort, challengeSigningKey, cookies, now: () => now, sessionSigningKey, telemetry });
    await actions.submitTotp(totpForm('111111'));
    expect(events).toEqual([expect.objectContaining({ correlationId: expect.stringMatching(uuidV7Pattern), operation: 'login.totp', reason: 'UPSTREAM_FAILURE', traceId: expect.stringMatching(traceIdPattern) })]);
  });
});

describe('admin authorization boundary', () => {
  const signingKey = 'test-only-signing-key-at-least-32-bytes';

  it('requires canonical 32-byte MFA opaque fields and bounded challenge expiry', async () => {
    const canonical = 'A'.repeat(43);
    const alias = equivalentNonCanonicalSegment(canonical);
    expect(isValidAdminMfaChallengeId(canonical)).toBe(true);
    expect(alias).toBeDefined();
    expect(isValidAdminMfaChallengeId(alias)).toBe(false);
    expect(isValidAdminMfaChallengeId(`${canonical}=`)).toBe(false);

    const currentTime = Date.now();
    const claims = {
      audience: 'admin-mfa', correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', expiresAt: currentTime + ADMIN_MFA_CHALLENGE_TTL_MS,
      identifierBinding: 'A'.repeat(43), seed: 'A'.repeat(43), stage: 'PASSWORD', version: 1,
    } as const;
    const boundary = await signAdminMfaChallenge(claims as never, signingKey);
    await expect(verifyAdminMfaChallenge(boundary, signingKey, currentTime)).resolves.toMatchObject({ stage: 'PASSWORD' });
    await expect(verifyAdminMfaChallenge(boundary, signingKey, currentTime + ADMIN_MFA_CHALLENGE_TTL_MS)).resolves.toBeNull();
    const overlong = await signAdminMfaChallenge({ ...claims, expiresAt: currentTime + ADMIN_MFA_CHALLENGE_TTL_MS + 1 } as never, signingKey);
    await expect(verifyAdminMfaChallenge(overlong, signingKey, currentTime)).resolves.toBeNull();
    await expect(signAdminMfaChallenge({ ...claims, challengeId: canonical } as never, signingKey)).rejects.toThrow('Invalid admin MFA claims');
  });

  it('rejects extra signed session claims', async () => {
    await expect(signAdminSession({
      dataScope: 'ALL',
      expiresAt: Date.now() + 60_000,
      permissions: ['users:read'],
      sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
      secret: 'tainted',
    } as never, signingKey)).rejects.toThrow('Invalid admin session claims');
  });

  it('enforces the frozen unique bounded permission set and a browser-safe token bound', async () => {
    const claims = {
      dataScope: 'ALL' as const,
      expiresAt: Date.now() + 60_000,
      permissions: allAdminPermissions,
      sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
    };
    const token = await signAdminSession(claims, signingKey);
    expect(token.length).toBeLessThanOrEqual(3000);
    await expect(verifyAdminSession(token, signingKey)).resolves.toMatchObject({ permissions: allAdminPermissions });
    for (const permissions of [
      ['unknown:permission'],
      ['users:read', 'users:read'],
      [...allAdminPermissions, 'users:read'],
      ['x'.repeat(5000)],
    ]) {
      await expect(signAdminSession({ ...claims, permissions } as never, signingKey)).rejects.toThrow('Invalid admin session claims');
    }
    await expect(verifyAdminSession('A'.repeat(3001), signingKey)).resolves.toBeNull();
  });

  it('rejects non-canonical and malformed MFA token segments', async () => {
    const token = await signAdminMfaChallenge({
      audience: 'admin-mfa',
      challengeId: 'A'.repeat(43),
      correlationId: '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
      expiresAt: Date.now() + 60_000,
      identifierBinding: 'A'.repeat(43),
      seed: 'A'.repeat(43),
      stage: 'TOTP',
      version: 1,
    }, signingKey);
    const [payload = '', signature = ''] = token.split('.');
    const alias = equivalentNonCanonicalSegment(signature);
    expect(alias).toBeDefined();
    if (!alias) throw new Error('Expected a non-canonical base64url alias');
    for (const candidate of [`${payload}.${alias}`, `${payload}.${signature}=`, `${payload}.${signature}.extra`, `${'A'.repeat(5000)}.${signature}`, `${payload}.+/=`]) {
      await expect(verifyAdminMfaChallenge(candidate, signingKey)).resolves.toBeNull();
    }
  });

  it('rejects non-canonical, padded, extra-segment, and overlong session token encodings', async () => {
    const token = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read'], sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f', subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }, signingKey);
    const [payload = '', signature = ''] = token.split('.');
    const alias = equivalentNonCanonicalSegment(signature);
    expect(alias).toBeDefined();
    if (!alias) throw new Error('Expected a non-canonical base64url alias');
    for (const candidate of [`${payload}.${alias}`, `${payload}.${signature}=`, `${payload}.${signature}.extra`, `${'A'.repeat(5000)}.${signature}`, `${payload}.+/=`]) {
      await expect(verifyAdminSession(candidate, signingKey)).resolves.toBeNull();
    }
  });

  it.each(['550e8400-e29b-41d4-a716-446655440000', 'arbitrary-admin'])('refuses to issue a session for a non-UUIDv7 subject (%s)', async (subjectId) => {
    await expect(signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read'], sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f', subjectId }, signingKey)).rejects.toThrow('Invalid admin session claims');
  });

  it.each([undefined, '550e8400-e29b-41d4-a716-446655440000', ' arbitrary '])('refuses a missing or malformed session instance (%s)', async (sessionInstanceId) => {
    await expect(signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read'], sessionInstanceId, subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' } as never, signingKey)).rejects.toThrow('Invalid admin session claims');
  });

  it('accepts an uppercase UUIDv7 instance without normalizing the signed authority value', async () => {
    const sessionInstanceId = '0198F7A4-C6DA-7B39-8A4E-73AF0C1D2E3F';
    const token = await signAdminSession({ dataScope: 'ALL', expiresAt: Date.now() + 60_000, permissions: ['users:read'], sessionInstanceId, subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }, signingKey);
    await expect(verifyAdminSession(token, signingKey)).resolves.toMatchObject({ sessionInstanceId });
  });

  it('rejects a protected server action without authentication', async () => {
    await expect(
      requireAdminPermission('users:read', {
        sessionToken: undefined,
        signingKey,
      }),
    ).rejects.toEqual(
      new AuthorizationError('UNAUTHENTICATED', '需要管理员登录'),
    );
  });

  it('independently rejects a server action without its required permission', async () => {
    const sessionToken = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f",
        permissions: ['users:read'],
        dataScope: 'ASSIGNED',
        expiresAt: Date.now() + 60_000,
      },
      signingKey,
    );

    await expect(
      requireAdminPermission('finance:read', { sessionToken, signingKey }),
    ).rejects.toEqual(
      new AuthorizationError('FORBIDDEN', '权限不足'),
    );
    await expect(
      requireAdminPermission('users:read', { sessionToken, signingKey }),
    ).resolves.toMatchObject({ subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', dataScope: 'ASSIGNED' });
  });

  it('redirects an unauthenticated protected route through the Next 16 proxy', async () => {
    const response = await proxy(
      new NextRequest('https://admin.ai-video.internal/users?cursor=next'),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe(
      'https://admin.ai-video.internal/login?next=%2Fusers%3Fcursor%3Dnext',
    );
  });

  it('keeps declared task filters in the unauthenticated login return location', async () => {
    const response = await proxy(
      new NextRequest(
        'https://admin.ai-video.internal/tasks?cursor=next_1&query=failed-job&status=FAILED',
      ),
    );
    const location = response.headers.get('location');

    expect(response.status).toBe(307);
    expect(location).toBe(
      'https://admin.ai-video.internal/login?next=%2Ftasks%3Fcursor%3Dnext_1%26query%3Dfailed-job%26status%3DFAILED',
    );
    if (!location) throw new Error('Missing login redirect');
    const loginResponse = await proxy(new NextRequest(location));
    expect(loginResponse.status).toBe(200);
    expect(loginResponse.headers.get('location')).toBeNull();
  });

  it('preserves each declared list filter while removing undeclared query parameters', async () => {
    const sessionToken = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['*'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      signingKey,
    );
    process.env.ADMIN_SESSION_SIGNING_KEY = signingKey;
    try {
      const cases = [
        ['/tasks', new URLSearchParams({ cursor: 'next_1', query: 'failed-job', status: 'FAILED' })],
        ['/tickets', new URLSearchParams({ cursor: 'next_1', query: 'refund', status: 'OPEN' })],
        ['/content', new URLSearchParams({ cursor: 'next_1', status: 'PUBLISHED' })],
        [
          '/finance/invoices',
          new URLSearchParams({ cursor: 'next_1', query: 'invoice', status: 'ISSUED' }),
        ],
        ['/finance/ledger', new URLSearchParams({ cursor: 'next_1', query: 'entry' })],
        [
          '/finance/orders',
          new URLSearchParams({ cursor: 'next_1', query: 'order', status: 'PAID' }),
        ],
        [
          '/finance/reconciliation',
          new URLSearchParams({
            category: 'AMOUNT_MISMATCH',
            cursor: 'next_1',
            status: 'INVESTIGATING',
          }),
        ],
        [
          '/audit',
          new URLSearchParams({
            action: 'PUBLISH',
            actor: 'operator',
            cursor: 'next_1',
            from: '2026-09-01T00:00:00.000Z',
            resource: 'pricing',
            to: '2026-09-12T00:00:00.000Z',
            traceId: '0123456789abcdef0123456789abcdef',
          }),
        ],
      ] as const;
      for (const [pathname, params] of cases) {
        const filtered = await proxy(
          new NextRequest(`https://admin.ai-video.internal${pathname}?${params.toString()}`, {
            headers: { cookie: `__Host-admin_session=${sessionToken}` },
          }),
        );
        expect(filtered.status, pathname).toBe(200);
        expect(filtered.headers.get('location'), pathname).toBeNull();
      }

      const sanitized = await proxy(
        new NextRequest(
          'https://admin.ai-video.internal/tasks?future=drop&status=FAILED&query=failed-job&cursor=next_1',
          { headers: { cookie: `__Host-admin_session=${sessionToken}` } },
        ),
      );
      expect(sanitized.status).toBe(307);
      expect(sanitized.headers.get('location')).toBe(
        'https://admin.ai-video.internal/tasks?cursor=next_1&query=failed-job&status=FAILED',
      );
    } finally {
      delete process.env.ADMIN_SESSION_SIGNING_KEY;
    }
  });

  it('allows the public login route through the proxy', async () => {
    const response = await proxy(
      new NextRequest('https://admin.ai-video.internal/login'),
    );

    expect(response.headers.get('location')).toBeNull();
  });

  it('does not exempt login-prefixed routes from the proxy matcher', () => {
    expect(config.matcher).toEqual([
      '/((?!_next/static|_next/image|favicon.ico).*)',
    ]);
  });

  it('returns 403 when an authenticated subject lacks the route permission', async () => {
    const sessionToken = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f",
        permissions: ['users:read'],
        dataScope: 'OWN',
        expiresAt: Date.now() + 60_000,
      },
      signingKey,
    );
    process.env.ADMIN_SESSION_SIGNING_KEY = signingKey;

    try {
      const response = await proxy(
        new NextRequest('https://admin.ai-video.internal/finance', {
          headers: { cookie: `__Host-admin_session=${sessionToken}` },
        }),
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({ error: 'FORBIDDEN' });
    } finally {
      delete process.env.ADMIN_SESSION_SIGNING_KEY;
    }
  });

  it('fails closed for every planned secure root and dynamic sub-route', async () => {
    const sessionToken = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f",
        permissions: [],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      signingKey,
    );
    process.env.ADMIN_SESSION_SIGNING_KEY = signingKey;

    try {
      const securePaths = [
        '/overview',
        '/users/0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
        '/providers/provider-1',
        '/models/model-1',
        '/pricing',
        '/routing/simulations',
        '/tasks/task-1',
        '/finance/orders',
        '/content',
        '/tickets/ticket-1',
        '/iam/roles',
        '/audit',
        '/system/health',
      ];

      for (const pathname of securePaths) {
        const response = await proxy(
          new NextRequest(`https://admin.ai-video.internal${pathname}`, {
            headers: { cookie: `__Host-admin_session=${sessionToken}` },
          }),
        );
        expect(response.status, pathname).toBe(403);
      }
    } finally {
      delete process.env.ADMIN_SESSION_SIGNING_KEY;
    }
  });

  it('requires separate pricing and routing permissions', async () => {
    const sessionToken = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f",
        permissions: ['pricing:read'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      signingKey,
    );
    process.env.ADMIN_SESSION_SIGNING_KEY = signingKey;

    try {
      const pricingResponse = await proxy(
        new NextRequest('https://admin.ai-video.internal/pricing', {
          headers: { cookie: `__Host-admin_session=${sessionToken}` },
        }),
      );
      const routingResponse = await proxy(
        new NextRequest('https://admin.ai-video.internal/routing', {
          headers: { cookie: `__Host-admin_session=${sessionToken}` },
        }),
      );

      expect(pricingResponse.status).toBe(200);
      expect(routingResponse.status).toBe(403);
    } finally {
      delete process.env.ADMIN_SESSION_SIGNING_KEY;
    }
  });

  it('denies an authenticated request to an unknown secure route', async () => {
    const sessionToken = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f",
        permissions: ['*'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      signingKey,
    );
    process.env.ADMIN_SESSION_SIGNING_KEY = signingKey;

    try {
      const response = await proxy(
        new NextRequest('https://admin.ai-video.internal/future-admin', {
          headers: { cookie: `__Host-admin_session=${sessionToken}` },
        }),
      );

      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: 'NOT_FOUND' });
    } finally {
      delete process.env.ADMIN_SESSION_SIGNING_KEY;
    }
  });
});

describe('scoped server action authorization', () => {
  const signingKey = 'scope-test-signing-key-at-least-32-bytes';

  async function tokenFor(
    subjectId: string,
    dataScope: 'ALL' | 'OWN' | 'ASSIGNED',
    permissions: readonly string[] = ['users:refresh'],
  ) {
    return signAdminSession(
      {
        subjectId,
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions,
        dataScope,
        expiresAt: Date.now() + 60_000,
      },
      signingKey,
    );
  }

  it('enforces ALL, OWN and ASSIGNED resource scope and denies absent context', async () => {
    const resource = {
      ownerAdminId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f',
      assignedAdminIds: ['0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f'],
    };

    await expect(
      requireAdminScopedPermission('users:refresh', resource, {
        sessionToken: await tokenFor('0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', 'ALL'),
        signingKey,
      }),
    ).resolves.toMatchObject({ subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"});
    await expect(
      requireAdminScopedPermission('users:refresh', resource, {
        sessionToken: await tokenFor('0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', 'OWN'),
        signingKey,
      }),
    ).resolves.toMatchObject({ subjectId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' });
    await expect(
      requireAdminScopedPermission('users:refresh', resource, {
        sessionToken: await tokenFor('0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', 'ASSIGNED'),
        signingKey,
      }),
    ).resolves.toMatchObject({ subjectId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f' });
    await expect(
      requireAdminScopedPermission('users:refresh', resource, {
        sessionToken: await tokenFor('0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f', 'OWN'),
        signingKey,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      requireAdminScopedPermission('users:refresh', undefined, {
        sessionToken: await tokenFor('0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', 'ALL'),
        signingKey,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

});
