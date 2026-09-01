import type { FastifyReply } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AdminAuthService } from '../src/application/admin-auth.service.js';
import { AdminAuthController } from '../src/http/admin-auth.controller.js';
import { IamMetrics } from '../src/operational/metrics.js';

const session = {
  id: '018f0000-0000-7001-8000-000000000001',
  adminId: '018f0000-0000-7001-8000-000000000002',
  familyId: '018f0000-0000-7001-8000-000000000003',
};
const pair = { accessToken: 'signed.jwt', refreshToken: 'r'.repeat(43), session };

describe('AdminAuthController', () => {
  it('routes password, TOTP, recovery and refresh while setting the strict cookie', async () => {
    const auth = {
      verifyPassword: vi.fn(() => Promise.resolve({ challengeId: 'challenge' })),
      verifyTotp: vi.fn(() => Promise.resolve(pair)),
      verifyRecoveryCode: vi.fn(() => Promise.resolve(pair)),
      rotateRefresh: vi.fn(() => Promise.resolve(pair)),
    };
    const metrics = new IamMetrics(() => Promise.resolve(1));
    const controller = new AdminAuthController(auth as unknown as AdminAuthService, metrics);
    const header = vi.fn();
    const reply = { header } as unknown as FastifyReply;

    await expect(controller.password({ email: 'admin@example.test', password: 'password-value' })).resolves.toEqual({ challengeId: 'challenge' });
    await expect(controller.totp({ challengeId: 'challenge', token: '123456', deviceName: 'browser' }, reply)).resolves.toEqual({ accessToken: 'signed.jwt', sessionId: session.id });
    await expect(controller.recovery({ challengeId: 'challenge', recoveryCode: 'code', deviceName: 'browser' }, reply)).resolves.toEqual({ accessToken: 'signed.jwt', sessionId: session.id });
    await expect(controller.refresh({ headers: { cookie: `admin_refresh=${'r'.repeat(43)}` } }, reply)).resolves.toEqual({ accessToken: 'signed.jwt', sessionId: session.id });
    expect(header).toHaveBeenCalledWith('Set-Cookie', expect.stringContaining('SameSite=Strict'));
    expect(await metrics.render()).toContain('iam_login_success_total 2');
  });

  it('counts password and second-factor failures and rejects ambiguous input', async () => {
    const failure = Object.assign(new Error('INVALID_MFA'), { code: 'INVALID_MFA' });
    const auth = {
      verifyPassword: vi.fn(() => Promise.reject(failure)),
      verifyTotp: vi.fn(() => Promise.reject(failure)),
    };
    const metrics = new IamMetrics(() => Promise.resolve(0));
    const controller = new AdminAuthController(auth as unknown as AdminAuthService, metrics);
    const reply = { header: vi.fn() } as unknown as FastifyReply;
    await expect(controller.password({ email: 'admin@example.test', password: 'wrong' })).rejects.toThrow('INVALID_MFA');
    await expect(controller.totp({ challengeId: 'challenge', token: '000000', deviceName: 'browser' }, reply)).rejects.toThrow('INVALID_MFA');
    await expect(controller.password({ email: 'a', password: 'b', extra: true })).rejects.toThrow('INVALID_REQUEST');
    await expect(controller.password(null)).rejects.toThrow('INVALID_REQUEST');
    const output = await metrics.render();
    expect(output).toContain('iam_login_failure_total 2');
    expect(output).toContain('iam_mfa_failures_total 1');
  });

  it('rejects missing, duplicate and empty refresh cookies', async () => {
    const auth = { rotateRefresh: vi.fn() };
    const controller = new AdminAuthController(auth as unknown as AdminAuthService);
    const reply = { header: vi.fn() } as unknown as FastifyReply;
    await expect(controller.refresh({ headers: {} }, reply)).rejects.toThrow('INVALID_REFRESH_TOKEN');
    await expect(controller.refresh({ headers: { cookie: 'admin_refresh=; x=1' } }, reply)).rejects.toThrow('INVALID_REFRESH_TOKEN');
    await expect(controller.refresh({ headers: { cookie: 'admin_refresh=a; admin_refresh=b' } }, reply)).rejects.toThrow('INVALID_REFRESH_TOKEN');
  });

  it('does not count signer, database, or finalization failures as MFA rejection', async () => {
    for (const code of ['ADMIN_TOKEN_ISSUANCE_FAILED', 'ADMIN_SESSION_FINALIZATION_FAILED', 'DATABASE_UNAVAILABLE']) {
      const auth = { verifyTotp: () => Promise.reject(Object.assign(new Error(code), { code })) };
      const metrics = new IamMetrics(() => Promise.resolve(0));
      const controller = new AdminAuthController(auth as unknown as AdminAuthService, metrics);
      await expect(controller.totp(
        { challengeId: 'challenge', token: '123456', deviceName: 'browser' },
        { header: vi.fn() } as unknown as FastifyReply,
      )).rejects.toThrow(code);
      expect(await metrics.render()).toContain('iam_mfa_failures_total 0');
    }
  });
});
