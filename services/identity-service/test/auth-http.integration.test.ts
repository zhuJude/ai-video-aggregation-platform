import 'reflect-metadata';

import { type INestApplication, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthController, BrowserRefreshController } from '../src/http/auth.controller.js';
import { JwtAccessGuard } from '../src/http/jwt-access.guard.js';

const userId = '0198fabc-1234-7abc-8abc-111111111111';
const sessionId = '0198fabc-1234-7abc-8abc-222222222222';

describe('identity HTTP boundary', () => {
  let app: INestApplication;
  let server: FastifyInstance;
  const sessions = {
    rotate: vi.fn(),
    create: vi.fn(),
    revoke: vi.fn(),
    list: vi.fn(),
  };
  const sms = { issue: vi.fn() };
  const accessVerifier = { verify: vi.fn() };
  const accounts = {
    authenticatePhone: vi.fn(),
    updateProfile: vi.fn(),
    currentPhone: vi.fn(),
    changePhone: vi.fn(),
    closeAccount: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    accessVerifier.verify.mockResolvedValue({ userId, sessionId });
    @Module({
      controllers: [AuthController, BrowserRefreshController],
      providers: [
        JwtAccessGuard,
        { provide: 'SESSION_SERVICE', useValue: sessions },
        { provide: 'SMS_CHALLENGE_SERVICE', useValue: sms },
        { provide: 'IDENTITY_ACCOUNT_SERVICE', useValue: accounts },
        {
          provide: 'ACCESS_TOKEN_VERIFIER',
          useValue: accessVerifier,
        },
      ],
    })
    // Nest requires a decorated module class as the runtime composition root.
    // eslint-disable-next-line @typescript-eslint/no-extraneous-class
    class HttpTestModule {}

    const adapter = new FastifyAdapter();
    app = await NestFactory.create(HttpTestModule, adapter, { logger: false });
    await app.init();
    server = adapter.getInstance();
  });

  afterEach(async () => {
    await app.close();
  });

  it('returns 400 for malformed bodies without invoking application services', async () => {
    const response = await server.inject({
      method: 'POST',
      url: '/v1/auth/sms/verify',
      payload: { phone: 13800138000, code: null },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ code: 'INVALID_REQUEST' });
    expect(accounts.authenticatePhone).not.toHaveBeenCalled();

    const invalidSession = await server.inject({
      method: 'DELETE',
      url: '/v1/sessions/not-a-uuid',
      headers: { authorization: 'Bearer valid.token.value' },
    });
    expect(invalidSession.statusCode).toBe(400);
    expect(invalidSession.json()).toEqual({ code: 'INVALID_REQUEST' });
    expect(sessions.revoke).not.toHaveBeenCalled();
  });

  it('maps guard failures to 401 and stable conflicts/rate limits to 409/429', async () => {
    const unauthorized = await server.inject({
      method: 'GET',
      url: '/v1/sessions',
    });
    expect(unauthorized.statusCode).toBe(401);
    expect(unauthorized.json()).toEqual({ code: 'INVALID_ACCESS_TOKEN' });

    accounts.updateProfile.mockRejectedValueOnce(
      Object.assign(new Error('internal text'), { code: 'IDEMPOTENCY_KEY_REUSED' }),
    );
    const conflict = await server.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: { authorization: 'Bearer valid.token.value' },
      payload: { nickname: 'valid' },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({ code: 'IDEMPOTENCY_KEY_REUSED' });

    sms.issue.mockRejectedValueOnce(
      Object.assign(new Error('redis detail'), { code: 'SMS_RATE_LIMITED' }),
    );
    const limited = await server.inject({
      method: 'POST',
      url: '/v1/auth/sms/request',
      payload: { phone: '13800138000', deviceId: 'browser-a' },
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toEqual({ code: 'SMS_RATE_LIMITED' });

    accounts.updateProfile.mockRejectedValueOnce(new Error('database secret'));
    const unknown = await server.inject({
      method: 'PATCH',
      url: '/v1/profile',
      headers: { authorization: 'Bearer valid.token.value' },
      payload: { nickname: 'valid' },
    });
    expect(unknown.statusCode).toBe(500);
    expect(unknown.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
  });

  it('sanitizes unknown access-verification dependency failures as 500, not 401', async () => {
    accessVerifier.verify.mockRejectedValueOnce(
      Object.assign(new Error('kms endpoint ECONNRESET secret-detail'), { code: 'ECONNRESET' }),
    );
    const outage = await server.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer valid.token.value' },
    });
    expect(outage.statusCode).toBe(500);
    expect(outage.json()).toEqual({ code: 'INTERNAL_SERVER_ERROR' });
    expect(outage.body).not.toContain('ECONNRESET');
    expect(outage.body).not.toContain('secret-detail');

    accessVerifier.verify.mockRejectedValueOnce(
      Object.assign(new Error('inactive'), { code: 'ACCESS_SESSION_INACTIVE' }),
    );
    const inactive = await server.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: 'Bearer valid.token.value' },
    });
    expect(inactive.statusCode).toBe(401);
    expect(inactive.json()).toEqual({ code: 'ACCESS_SESSION_INACTIVE' });
  });

  it('rejects an unchanged phone before issuing either SMS challenge', async () => {
    accounts.currentPhone.mockResolvedValueOnce('+8613800138000');
    const response = await server.inject({
      method: 'POST',
      url: '/v1/phone-change/sms/request',
      headers: { authorization: 'Bearer valid.token.value' },
      payload: { newPhoneE164: '13800138000', deviceId: 'browser-a' },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: 'PHONE_UNCHANGED' });
    expect(sms.issue).not.toHaveBeenCalled();
  });

  it('keeps the real browser refresh route aligned with the narrow cookie', async () => {
    sessions.rotate.mockResolvedValueOnce({
      accessToken: 'access',
      refreshToken: 'next-refresh',
      session: { id: sessionId },
    });
    const response = await server.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: 'refresh_token=current-refresh' },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers['set-cookie']).toBe(
      'refresh_token=next-refresh; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax',
    );
  });
});
