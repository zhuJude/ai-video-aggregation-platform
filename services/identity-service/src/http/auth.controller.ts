import {
  Body,
  Controller,
  createParamDecorator,
  Delete,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Req,
  Res,
  type ExecutionContext,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';

import type { IdentityAccountService } from '../application/identity-account.service.js';
import type { SessionService } from '../application/session.service.js';
import type { SmsChallengeService } from '../application/sms-challenge.service.js';
import { EventMetadata } from '../domain/event-metadata.js';
import { Phone } from '../domain/phone.js';
import { SmsRequestContext } from '../domain/sms-request-context.js';
import { AuthenticatedUser } from './authenticated-user.js';
import { IdentityHttpExceptionFilter } from './identity-http-exception.filter.js';
import { JwtAccessGuard } from './jwt-access.guard.js';
import {
  parseCloseAccountBody,
  parsePhoneChangeRequestBody,
  parsePhoneChangeVerifyBody,
  parseProfileBody,
  parseSessionId,
  parseSmsRequestBody,
  parseSmsVerifyBody,
} from './request-validation.js';

export { AuthenticatedUser } from './authenticated-user.js';

export interface RefreshCookie {
  readonly name: 'refresh_token';
  readonly value: string;
  readonly options: {
    readonly httpOnly: true;
    readonly secure: true;
    readonly sameSite: 'lax';
    readonly path: '/auth/refresh';
  };
}

export function refreshCookie(value: string): RefreshCookie {
  return {
    name: 'refresh_token',
    value,
    options: { httpOnly: true, secure: true, sameSite: 'lax', path: '/auth/refresh' },
  };
}

export function refreshCookieHeader(value: string): string {
  return `refresh_token=${encodeURIComponent(value)}; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax`;
}

export const TrustedPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const request = context.switchToHttp().getRequest<{ user: AuthenticatedUser }>();
    return AuthenticatedUser.assertTrusted(request.user);
  },
);

@Controller('v1')
@UseFilters(IdentityHttpExceptionFilter)
export class AuthController {
  constructor(
    @Inject('SESSION_SERVICE') private readonly sessions: SessionService,
    @Inject('SMS_CHALLENGE_SERVICE') private readonly sms: SmsChallengeService,
    @Inject('IDENTITY_ACCOUNT_SERVICE') private readonly accounts: IdentityAccountService,
  ) {}

  @Post('auth/sms/request')
  async requestSms(
    @Body() rawBody: unknown,
    @Req() request: Pick<FastifyRequest, 'ip'>,
  ): Promise<void> {
    const body = parseSmsRequestBody(rawBody);
    await this.sms.issue({
      phoneE164: Phone.parse(body.phone).e164,
      context: SmsRequestContext.fromDirectSocket({
        ipAddress: request.ip,
        deviceId: body.deviceId,
      }),
    });
  }

  @Post('auth/sms/verify')
  async verifySms(
    @Body() rawBody: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string; sessionId: string }> {
    const body = parseSmsVerifyBody(rawBody);
    const user = await this.accounts.authenticatePhone(body.phone, body.code);
    const pair = await this.sessions.create(user.id, body.deviceName);
    setRefreshCookie(reply, pair.refreshToken);
    return { accessToken: pair.accessToken, sessionId: pair.session.id };
  }

  @Post('auth/refresh')
  async refresh(
    @Req() request: Pick<FastifyRequest, 'headers'>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string; sessionId: string }> {
    const pair = await this.sessions.rotate(refreshTokenFromRequest(request));
    setRefreshCookie(reply, pair.refreshToken);
    return { accessToken: pair.accessToken, sessionId: pair.session.id };
  }

  @Post('auth/logout')
  @UseGuards(JwtAccessGuard)
  async logout(
    @TrustedPrincipal() principal: AuthenticatedUser,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const authenticated = AuthenticatedUser.assertTrusted(principal);
    await this.sessions.revoke(authenticated.userId, authenticated.sessionId);
    reply.header(
      'Set-Cookie',
      'refresh_token=; Path=/auth/refresh; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    );
  }

  @Get('sessions')
  @UseGuards(JwtAccessGuard)
  async listSessions(@TrustedPrincipal() principal: AuthenticatedUser) {
    const authenticated = AuthenticatedUser.assertTrusted(principal);
    return this.sessions.list(authenticated.userId);
  }

  @Delete('sessions/:id')
  @UseGuards(JwtAccessGuard)
  async revokeSession(
    @TrustedPrincipal() principal: AuthenticatedUser,
    @Param('id') rawSessionId: unknown,
  ): Promise<void> {
    const authenticated = AuthenticatedUser.assertTrusted(principal);
    const sessionId = parseSessionId(rawSessionId);
    await this.sessions.revoke(authenticated.userId, sessionId);
  }

  @Patch('profile')
  @UseGuards(JwtAccessGuard)
  async updateProfile(
    @TrustedPrincipal() principal: AuthenticatedUser,
    @Body() rawBody: unknown,
  ): Promise<void> {
    const authenticated = AuthenticatedUser.assertTrusted(principal);
    const body = parseProfileBody(rawBody);
    await this.accounts.updateProfile(authenticated.userId, body.nickname);
  }

  @Post('phone-change/sms/request')
  @UseGuards(JwtAccessGuard)
  async requestPhoneChangeSms(
    @TrustedPrincipal() principal: AuthenticatedUser,
    @Body() rawBody: unknown,
    @Req() request: Pick<FastifyRequest, 'ip'>,
  ): Promise<void> {
    const authenticated = AuthenticatedUser.assertTrusted(principal);
    const body = parsePhoneChangeRequestBody(rawBody);
    const currentPhone = await this.accounts.currentPhone(authenticated.userId);
    if (currentPhone === body.newPhoneE164) throw stableError('PHONE_UNCHANGED');
    const context = SmsRequestContext.fromDirectSocket({
      ipAddress: request.ip,
      deviceId: body.deviceId,
    });
    await Promise.all([
      this.sms.issue({ phoneE164: currentPhone, context }),
      this.sms.issue({ phoneE164: body.newPhoneE164, context }),
    ]);
  }

  @Post('phone-change/sms/verify')
  @UseGuards(JwtAccessGuard)
  async verifyPhoneChange(
    @TrustedPrincipal() principal: AuthenticatedUser,
    @Body() rawBody: unknown,
    @Req() request: Pick<FastifyRequest, 'headers'>,
  ): Promise<void> {
    const authenticated = AuthenticatedUser.assertTrusted(principal);
    const body = parsePhoneChangeVerifyBody(rawBody);
    await this.accounts.changePhone({
      userId: authenticated.userId,
      ...body,
      eventMetadata: ingressEventMetadata(request),
    });
  }

  @Delete('account')
  @UseGuards(JwtAccessGuard)
  async closeAccount(
    @TrustedPrincipal() principal: AuthenticatedUser,
    @Body() rawBody: unknown,
    @Req() request: Pick<FastifyRequest, 'headers'>,
  ): Promise<void> {
    const authenticated = AuthenticatedUser.assertTrusted(principal);
    const body = parseCloseAccountBody(rawBody);
    await this.accounts.closeAccount({
      userId: authenticated.userId,
      ...body,
      eventMetadata: ingressEventMetadata(request),
    });
  }
}

@Controller('auth')
@UseFilters(IdentityHttpExceptionFilter)
export class BrowserRefreshController {
  constructor(@Inject('SESSION_SERVICE') private readonly sessions: SessionService) {}

  @Post('refresh')
  async refresh(
    @Req() request: Pick<FastifyRequest, 'headers'>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ accessToken: string; sessionId: string }> {
    const pair = await this.sessions.rotate(refreshTokenFromRequest(request));
    setRefreshCookie(reply, pair.refreshToken);
    return { accessToken: pair.accessToken, sessionId: pair.session.id };
  }
}

function setRefreshCookie(reply: FastifyReply, value: string): void {
  reply.header('Set-Cookie', refreshCookieHeader(value));
}

function refreshTokenFromRequest(request: Pick<FastifyRequest, 'headers'>): string {
  const cookieHeader = request.headers.cookie;
  if (typeof cookieHeader !== 'string') throw stableError('REFRESH_COOKIE_REQUIRED');
  const matches = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('refresh_token='));
  if (matches.length !== 1) throw stableError('INVALID_REFRESH_COOKIE');
  const encoded = matches[0]?.slice('refresh_token='.length) ?? '';
  try {
    const token = decodeURIComponent(encoded);
    if (!token) throw stableError('INVALID_REFRESH_COOKIE');
    return token;
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error) throw error;
    throw stableError('INVALID_REFRESH_COOKIE');
  }
}

function ingressEventMetadata(request: Pick<FastifyRequest, 'headers'>): EventMetadata {
  const traceId = singleHeader(request.headers['x-trace-id']);
  const correlationId = singleHeader(request.headers['x-correlation-id']);
  const causationId = singleHeader(request.headers['x-causation-id']);
  return EventMetadata.fromIngress({
    ...(traceId ? { traceId } : {}),
    ...(correlationId ? { correlationId } : {}),
    ...(causationId ? { causationId } : {}),
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
