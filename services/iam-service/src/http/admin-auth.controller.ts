import { Body, Controller, Inject, Optional, Post, Req, Res, UseFilters } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AdminAuthService } from '../application/admin-auth.service.js';
import type { IamMetrics } from '../operational/metrics.js';
import { adminRefreshCookie } from './admin-refresh-cookie.js';
import { IamHttpExceptionFilter } from './iam-http-exception.filter.js';

@Controller('v1/admin/auth')
@UseFilters(IamHttpExceptionFilter)
export class AdminAuthController {
  constructor(
    @Inject('ADMIN_AUTH_SERVICE') private readonly auth: AdminAuthService,
    @Optional() @Inject('SERVICE_METRICS') private readonly metrics?: IamMetrics,
  ) {}

  @Post('password')
  async password(@Body() raw: unknown) {
    const body = exact(raw, ['email', 'password']);
    try {
      return await this.auth.verifyPassword(text(body['email']), text(body['password']));
    } catch (error) {
      this.metrics?.increment('iam_login_failure_total');
      throw error;
    }
  }

  @Post('mfa/totp')
  totp(@Body() raw: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const body = exact(raw, ['challengeId', 'token', 'deviceName']);
    return this.completeMfa(
      () => this.auth.verifyTotp(text(body['challengeId']), text(body['token']), text(body['deviceName'])),
      reply,
    );
  }

  @Post('mfa/recovery')
  recovery(@Body() raw: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const body = exact(raw, ['challengeId', 'recoveryCode', 'deviceName']);
    return this.completeMfa(
      () => this.auth.verifyRecoveryCode(text(body['challengeId']), text(body['recoveryCode']), text(body['deviceName'])),
      reply,
    );
  }

  @Post('refresh')
  async refresh(@Req() request: Pick<FastifyRequest, 'headers'>, @Res({ passthrough: true }) reply: FastifyReply) {
    const pair = await this.auth.rotateRefresh(refreshFromCookie(request.headers.cookie));
    reply.header('Set-Cookie', adminRefreshCookie(pair.refreshToken));
    return { accessToken: pair.accessToken, sessionId: pair.session.id };
  }

  private async completeMfa(
    work: () => ReturnType<AdminAuthService['verifyTotp']>,
    reply: FastifyReply,
  ) {
    try {
      const pair = await work();
      reply.header('Set-Cookie', adminRefreshCookie(pair.refreshToken));
      this.metrics?.increment('iam_login_success_total');
      return { accessToken: pair.accessToken, sessionId: pair.session.id };
    } catch (error) {
      this.metrics?.increment('iam_login_failure_total');
      if (isMfaRejection(error)) this.metrics?.increment('iam_mfa_failures_total');
      throw error;
    }
  }
}

function exact(input: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw stableError('INVALID_REQUEST');
  const value = input as Record<string, unknown>;
  if (Object.keys(value).some((key) => !fields.includes(key))) throw stableError('INVALID_REQUEST');
  return value;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) throw stableError('INVALID_REQUEST');
  return value;
}
function refreshFromCookie(value: string | string[] | undefined): string {
  if (typeof value !== 'string') throw stableError('INVALID_REFRESH_TOKEN');
  const matches = value.split(';').map((part) => part.trim()).filter((part) => part.startsWith('admin_refresh='));
  if (matches.length !== 1) throw stableError('INVALID_REFRESH_TOKEN');
  const token = matches[0]?.slice('admin_refresh='.length) ?? '';
  if (!token) throw stableError('INVALID_REFRESH_TOKEN');
  return token;
}
function stableError(code: string): Error & { code: string } { return Object.assign(new Error(code), { code }); }
function isMfaRejection(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return false;
  return new Set([
    'INVALID_MFA',
    'MFA_CHALLENGE_EXPIRED',
    'MFA_CHALLENGE_USED',
    'MFA_CHALLENGE_LOCKED',
    'MFA_REPLAY_DETECTED',
  ]).has(error.code);
}
