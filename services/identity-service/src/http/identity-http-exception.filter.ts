import { Catch, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';

const UNAUTHORIZED = new Set([
  'ACCESS_SESSION_INACTIVE',
  'INVALID_ACCESS_TOKEN',
  'INVALID_REFRESH_TOKEN',
  'PHONE_VERIFICATION_FAILED',
  'REFRESH_COOKIE_REQUIRED',
  'REFRESH_REUSE_DETECTED',
  'SESSION_EXPIRED',
  'SESSION_REVOKED',
]);
const CONFLICT = new Set([
  'IDEMPOTENCY_KEY_REUSED',
  'PHONE_ALREADY_IN_USE',
  'PHONE_UNCHANGED',
  'SENSITIVE_OPERATION_REVERIFY_REQUIRED',
  'SESSION_NOT_FOUND',
  'USER_INACTIVE',
  'USER_STATE_CHANGED',
]);
const RATE_LIMITED = new Set(['SMS_CHALLENGE_LOCKED', 'SMS_RATE_LIMITED']);
const BAD_REQUEST = new Set([
  'INVALID_DEVICE_NAME',
  'INVALID_OPERATION_ID',
  'INVALID_PHONE',
  'INVALID_REFRESH_COOKIE',
  'INVALID_REQUEST',
  'INVALID_SESSION_ID',
  'INVALID_SMS_CODE',
]);
const UNAVAILABLE = new Set(['CLOUD_SDK_UNAVAILABLE', 'ALIYUN_SMS_SEND_FAILED']);

@Catch()
export class IdentityHttpExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const code = stableCode(exception);
    const status = statusFor(code);
    reply.status(status).send({ code: status === 500 ? 'INTERNAL_SERVER_ERROR' : code });
  }
}

function stableCode(exception: unknown): string {
  if (
    exception instanceof Error &&
    'code' in exception &&
    typeof exception.code === 'string'
  ) {
    return exception.code;
  }
  return 'INTERNAL_SERVER_ERROR';
}

function statusFor(code: string): number {
  if (UNAUTHORIZED.has(code)) return 401;
  if (CONFLICT.has(code)) return 409;
  if (RATE_LIMITED.has(code)) return 429;
  if (BAD_REQUEST.has(code)) return 400;
  if (UNAVAILABLE.has(code)) return 503;
  return 500;
}
