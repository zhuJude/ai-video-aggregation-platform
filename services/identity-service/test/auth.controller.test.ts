import 'reflect-metadata';

import { PATH_METADATA } from '@nestjs/common/constants.js';
import { GUARDS_METADATA } from '@nestjs/common/constants.js';
import { describe, expect, it, vi } from 'vitest';

import {
  AuthController,
  AuthenticatedUser,
  BrowserRefreshController,
  refreshCookie,
  refreshCookieHeader,
} from '../src/http/auth.controller.js';
import { JwtAccessGuard } from '../src/http/jwt-access.guard.js';

describe('AuthController', () => {
  it('exposes every planned route', () => {
    const methods = Object.getOwnPropertyNames(AuthController.prototype).filter(
      (name) => name !== 'constructor',
    );
    const paths = methods.map(
      (name) =>
        Reflect.getMetadata(
          PATH_METADATA,
          AuthController.prototype[name as keyof AuthController],
        ) as string | undefined,
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        'auth/sms/request',
        'auth/sms/verify',
        'auth/refresh',
        'auth/logout',
        'sessions',
        'sessions/:id',
        'profile',
        'phone-change/sms/request',
        'phone-change/sms/verify',
        'account',
      ]),
    );
  });

  it('exposes a browser refresh route that matches the narrow cookie path', () => {
    expect(Reflect.getMetadata(PATH_METADATA, BrowserRefreshController)).toBe('auth');
    const refreshMethod: unknown = Object.getOwnPropertyDescriptor(
      BrowserRefreshController.prototype,
      'refresh',
    )?.value;
    if (typeof refreshMethod !== 'function') throw new Error('MISSING_BROWSER_REFRESH_ROUTE');
    expect(Reflect.getMetadata(PATH_METADATA, refreshMethod) as string).toBe('refresh');
  });

  it('sets the refresh cookie with the exact browser security attributes', () => {
    expect(refreshCookie('token-value')).toEqual({
      name: 'refresh_token',
      value: 'token-value',
      options: {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/auth/refresh',
      },
    });
    expect(refreshCookieHeader('token-value')).toBe(
      'refresh_token=token-value; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('rotates from the HttpOnly cookie and never requires the refresh token in a body', async () => {
    const rotate = vi.fn().mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'next_refresh',
      session: { id: 's2' },
    });
    const header = vi.fn();
    const controller = new AuthController({ rotate } as never, {} as never, {} as never);

    await expect(
      controller.refresh(
        { headers: { cookie: 'other=x; refresh_token=current_refresh; theme=dark' } } as never,
        { header } as never,
      ),
    ).resolves.toEqual({ accessToken: 'access', sessionId: 's2' });
    expect(rotate).toHaveBeenCalledWith('current_refresh');
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      'refresh_token=next_refresh; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax',
    );
  });

  it('logs out using only the verified principal session and expires the cookie', async () => {
    const revoke = vi.fn().mockResolvedValue(undefined);
    const header = vi.fn();
    const controller = new AuthController({ revoke } as never, {} as never, {} as never);
    const principal = AuthenticatedUser.fromGuard(
      '0198fabc-1234-7abc-8abc-111111111111',
      '0198fabc-1234-7abc-8abc-222222222222',
    );

    await controller.logout(principal, { header } as never);

    expect(revoke).toHaveBeenCalledWith(principal.userId, principal.sessionId);
    expect(header).toHaveBeenCalledWith(
      'Set-Cookie',
      'refresh_token=; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
  });

  it('attaches the JWT session guard to every protected route', () => {
    for (const method of [
      'logout',
      'listSessions',
      'revokeSession',
      'updateProfile',
      'requestPhoneChangeSms',
      'verifyPhoneChange',
      'closeAccount',
    ] as const) {
      const guards = Reflect.getMetadata(
        GUARDS_METADATA,
        AuthController.prototype[method],
      ) as unknown[];
      expect(guards).toContain(JwtAccessGuard);
    }
  });

  it('rejects a forged authenticated principal at protected endpoints', async () => {
    const sessionService = {
      list: vi.fn(),
      revoke: vi.fn(),
      rotate: vi.fn(),
      logout: vi.fn(),
      create: vi.fn(),
    };
    const controller = new AuthController(
      sessionService as never,
      { issue: vi.fn(), verify: vi.fn() } as never,
      { changePhone: vi.fn(), closeAccount: vi.fn(), updateProfile: vi.fn() } as never,
    );

    await expect(
      controller.listSessions({ userId: 'u1' } as AuthenticatedUser),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_AUTHENTICATED_USER' });
    expect(sessionService.list).not.toHaveBeenCalled();
  });

  it('constructs SMS context from the direct socket instead of accepting a body-supplied context', async () => {
    const issue = vi.fn().mockResolvedValue(undefined);
    const controller = new AuthController(
      {} as never,
      { issue, verify: vi.fn() } as never,
      {} as never,
    );
    await controller.requestSms(
      {
        phone: '13800138000',
        deviceId: 'browser-a',
        context: { canonicalIp: '198.51.100.1', canonicalDeviceId: 'forged' },
      } as never,
      { ip: '203.0.113.8' },
    );

    const issuedInput: unknown = issue.mock.calls[0]?.[0];
    expect(issuedInput).toMatchObject({
      phoneE164: '+8613800138000',
      context: {
        canonicalIp: '203.0.113.8',
        canonicalDeviceId: 'browser-a',
      },
    });
  });

  it('uses the frozen domestic phone field for SMS login and normalizes at the application boundary', async () => {
    const authenticatePhone = vi.fn().mockResolvedValue({
      id: '0198fabc-1234-7abc-8abc-111111111111',
    });
    const create = vi.fn().mockResolvedValue({
      accessToken: 'access',
      refreshToken: 'refresh',
      session: { id: '0198fabc-1234-7abc-8abc-222222222222' },
    });
    const header = vi.fn();
    const controller = new AuthController(
      { create } as never,
      {} as never,
      { authenticatePhone } as never,
    );

    await controller.verifySms({ phone: '13800138000', code: '123456', deviceName: 'Chrome' }, {
      header,
    } as never);

    expect(authenticatePhone).toHaveBeenCalledWith('13800138000', '123456');
    expect(create).toHaveBeenCalledWith('0198fabc-1234-7abc-8abc-111111111111', 'Chrome');
  });

  it('replaces invalid event headers after principal verification', async () => {
    const closeAccount = vi.fn().mockResolvedValue(undefined);
    const controller = new AuthController({} as never, {} as never, { closeAccount } as never);
    const principal = AuthenticatedUser.fromGuard(
      '0198fabc-1234-7abc-8abc-111111111111',
      '0198fabc-1234-7abc-8abc-222222222222',
    );
    await controller.closeAccount(
      principal,
      { code: '123456', operationId: '0198fabc-1234-7abc-8abc-333333333333' },
      {
        headers: {
          'x-trace-id': 'forged',
          'x-correlation-id': 'not-v7',
          'x-causation-id': 'not-v7',
        },
      } as never,
    );

    const input: unknown = closeAccount.mock.calls[0]?.[0];
    const inputRecord = input as { userId?: unknown; eventMetadata?: unknown };
    const metadata = inputRecord.eventMetadata as {
      traceId?: unknown;
      correlationId?: unknown;
      causationId?: unknown;
    };
    expect(inputRecord.userId).toBe(principal.userId);
    expect(metadata.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(metadata.correlationId).toMatch(/-7[0-9a-f]{3}-[89ab]/);
    expect(metadata.causationId).toBeUndefined();
  });

  it('creates principals only through the trusted guard factory', () => {
    const principal = AuthenticatedUser.fromGuard(
      '0198fabc-1234-7abc-8abc-111111111111',
      '0198fabc-1234-7abc-8abc-222222222222',
    );
    expect(AuthenticatedUser.assertTrusted(principal)).toBe(principal);
    expect(() =>
      AuthenticatedUser.assertTrusted({ userId: 'u1', sessionId: 's1' } as AuthenticatedUser),
    ).toThrow('UNTRUSTED_AUTHENTICATED_USER');
    expect(Reflect.set(AuthenticatedUser, 'assertTrusted', () => principal)).toBe(false);
    expect(Reflect.set(AuthenticatedUser.prototype, 'userId', 'attacker')).toBe(false);
    expect(() => AuthenticatedUser.fromGuard('v4-user', 'v4-session')).toThrow(
      'INVALID_AUTHENTICATED_USER',
    );
  });
});
