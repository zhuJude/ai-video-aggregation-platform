/* eslint-disable @typescript-eslint/require-await -- async fakes implement production port signatures. */

import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
import {
  ADMIN_MFA_CHALLENGE_COOKIE,
  ADMIN_SESSION_COOKIE,
  signAdminMfaChallenge,
  verifyAdminMfaChallenge,
} from '../lib/session-auth';
import {
  type ResourceScopePort,
  type UserOperationPort,
  createRefreshUserAction,
} from '../lib/protected-user-action';

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
      '定价路由',
      '任务',
      '财务',
      '内容运营',
      '工单',
      '后台权限',
      '审计',
      '系统运行',
    ]);
    expect(screen.getByRole('link', { name: '定价路由' })).toHaveAttribute(
      'href',
      '/pricing',
    );
  });

  it('shows the admin identity, command search, breadcrumbs and environment', () => {
    render(
      <AdminShell
        breadcrumbs={[
          { label: '用户', href: '/users' },
          { label: '账户详情', href: '/users/user-9' },
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
        totpAction={totpAction}
      />,
    );

    fireEvent.change(screen.getByLabelText(/管理员账号/), {
      target: { value: 'operator@example.invalid' },
    });
    fireEvent.change(screen.getByLabelText(/密码/), {
      target: { value: 'not-a-real-password' },
    });
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

  it('keeps password outcomes indistinguishable while storing only a server challenge', async () => {
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

    await expect(accepted.submitPassword(passwordForm())).resolves.toEqual(
      await rejected.submitPassword(passwordForm()),
    );
    expect(acceptedCookies.writes).toHaveLength(1);
    expect(acceptedCookies.writes[0]).toMatchObject({
      name: ADMIN_MFA_CHALLENGE_COOKIE,
      options: { httpOnly: true, maxAge: 600, sameSite: 'strict', secure: true },
    });
    expect(rejectedCookies.writes).toHaveLength(1);
    expect(rejectedCookies.writes[0]?.options).toEqual(
      acceptedCookies.writes[0]?.options,
    );
    expect(rejectedCookies.writes[0]?.value).toHaveLength(
      acceptedCookies.writes[0]?.value.length ?? 0,
    );
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

    await expect(actions.submitPassword(passwordForm())).resolves.toEqual(
      publicPasswordStepResult(),
    );
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
    expect(claims?.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);

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
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'opaque-iam-challenge',
          expiresAt: now + 600_000,
        };
      },
      async verifyTotp() {
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
  });

  it('keeps IAM cooldown authoritative when an old challenge cookie is replayed', async () => {
    const cookies = createCookiePort();
    let failures = 0;
    const authPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'iam-owned-lockout',
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

  it('sets an indistinguishable challenge cookie for accepted and decoy password outcomes', async () => {
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

    expect(decoyResult).toEqual(acceptedResult);
    expect(decoyCookies.writes).toHaveLength(acceptedCookies.writes.length);
    expect(decoyCookies.writes[0]?.options).toEqual(
      acceptedCookies.writes[0]?.options,
    );
    expect(decoyCookies.writes[0]?.value).toHaveLength(
      acceptedCookies.writes[0]?.value.length ?? 0,
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
      'challengeId',
      'expiresAt',
    ]);
    expect(Object.keys(decoyClaims ?? {}).sort()).toEqual([
      'challengeId',
      'expiresAt',
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
          challengeId: '55555555-5555-4555-8555-555555555555',
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
          challengeId: '66666666-6666-4666-8666-666666666666',
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
        { challengeId: 'expired-challenge', expiresAt: now - 1 },
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
    const authPort: AdminAuthPort = {
      async beginPasswordChallenge() {
        return {
          challengeId: 'opaque-iam-challenge',
          expiresAt: now + 120_000,
        };
      },
      async verifyTotp() {
        return {
          kind: 'AUTHENTICATED',
          subject: {
            subjectId: 'admin-9',
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
    });
    await actions.submitPassword(passwordForm());

    const result = await actions.submitTotp(totpForm('042731'));

    expect(result).toEqual({ status: 'AUTHENTICATED', redirectTo: '/overview' });
    expect(result).not.toHaveProperty('sessionToken');
    expect(cookies.get(ADMIN_MFA_CHALLENGE_COOKIE)).toBeUndefined();
    expect(cookies.writes.at(-1)).toMatchObject({
      name: ADMIN_SESSION_COOKIE,
      options: { httpOnly: true, sameSite: 'strict', secure: true },
    });
  });
});

describe('admin authorization boundary', () => {
  const signingKey = 'test-only-signing-key-at-least-32-bytes';

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
        subjectId: 'admin-1',
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
    ).resolves.toMatchObject({ subjectId: 'admin-1', dataScope: 'ASSIGNED' });
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
        subjectId: 'admin-2',
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
        subjectId: 'admin-no-routes',
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
        '/users/user-1',
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
        subjectId: 'pricing-admin',
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
        subjectId: 'admin-unknown-route',
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
        permissions,
        dataScope,
        expiresAt: Date.now() + 60_000,
      },
      signingKey,
    );
  }

  it('enforces ALL, OWN and ASSIGNED resource scope and denies absent context', async () => {
    const resource = {
      ownerAdminId: 'owner-admin',
      assignedAdminIds: ['assigned-admin'],
    };

    await expect(
      requireAdminScopedPermission('users:refresh', resource, {
        sessionToken: await tokenFor('any-admin', 'ALL'),
        signingKey,
      }),
    ).resolves.toMatchObject({ subjectId: 'any-admin' });
    await expect(
      requireAdminScopedPermission('users:refresh', resource, {
        sessionToken: await tokenFor('owner-admin', 'OWN'),
        signingKey,
      }),
    ).resolves.toMatchObject({ subjectId: 'owner-admin' });
    await expect(
      requireAdminScopedPermission('users:refresh', resource, {
        sessionToken: await tokenFor('assigned-admin', 'ASSIGNED'),
        signingKey,
      }),
    ).resolves.toMatchObject({ subjectId: 'assigned-admin' });
    await expect(
      requireAdminScopedPermission('users:refresh', resource, {
        sessionToken: await tokenFor('other-admin', 'OWN'),
        signingKey,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      requireAdminScopedPermission('users:refresh', undefined, {
        sessionToken: await tokenFor('any-admin', 'ALL'),
        signingKey,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not invoke a protected operation when the action is unauthenticated', async () => {
    let scopeCalls = 0;
    let operationCalls = 0;
    const scopePort: ResourceScopePort = {
      async getUserScope() {
        scopeCalls += 1;
        return { ownerAdminId: 'admin-1', assignedAdminIds: [] };
      },
    };
    const operationPort: UserOperationPort = {
      async refreshUser() {
        operationCalls += 1;
      },
    };
    const action = createRefreshUserAction({
      scopePort,
      operationPort,
      guardContext: { sessionToken: undefined, signingKey },
    });
    const formData = new FormData();
    formData.set('userId', 'user-9');

    await expect(action(formData)).rejects.toMatchObject({
      code: 'UNAUTHENTICATED',
    });
    expect(scopeCalls).toBe(0);
    expect(operationCalls).toBe(0);
  });

  it('invokes the protected operation only after permission and scope checks', async () => {
    let operationCalls = 0;
    const scopePort: ResourceScopePort = {
      async getUserScope() {
        return {
          ownerAdminId: 'another-admin',
          assignedAdminIds: ['assigned-admin'],
        };
      },
    };
    const operationPort: UserOperationPort = {
      async refreshUser(input) {
        expect(input.userId).toBe('user-9');
        operationCalls += 1;
      },
    };
    const action = createRefreshUserAction({
      scopePort,
      operationPort,
      guardContext: {
        sessionToken: await tokenFor('assigned-admin', 'ASSIGNED'),
        signingKey,
      },
    });
    const formData = new FormData();
    formData.set('userId', 'user-9');

    await expect(action(formData)).resolves.toEqual({ ok: true });
    expect(operationCalls).toBe(1);
  });
});
