import { randomBytes } from 'node:crypto';
import type { NotificationService } from '../application/notification.consumer.js';
import { NotificationError } from '../application/notification.consumer.js';
import { UUID_V7_PATTERN } from '../domain/uuid-v7.js';

export type RawHeaders = Record<string, string | string[] | undefined>;
export interface NotificationHttpRequest {
  method: string;
  path: string;
  headers: RawHeaders;
  query?: Record<string, unknown>;
  body?: unknown;
}
export interface NotificationHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export interface UserPrincipal {
  userId: string;
}
export interface UserAuthenticator {
  authenticate(request: { headers: RawHeaders }): Promise<UserPrincipal | null>;
}

export class NotificationHttpModule {
  constructor(
    private readonly dependencies: {
      service: NotificationService;
      userAuthenticator: UserAuthenticator;
    },
  ) {}

  async handle(request: NotificationHttpRequest): Promise<NotificationHttpResponse> {
    const traceId =
      typeof request.headers['x-trace-id'] === 'string' &&
      /^[a-f0-9]{32}$/.test(request.headers['x-trace-id'])
        ? request.headers['x-trace-id']
        : randomBytes(16).toString('hex');
    try {
      const principal = await this.dependencies.userAuthenticator.authenticate({
        headers: request.headers,
      });
      if (principal === null) throw new HttpError('UNAUTHENTICATED', 401);
      if (request.method === 'GET' && request.path === '/v1/inbox') {
        const limitValue = request.query?.limit ?? 20;
        const limit = typeof limitValue === 'string' ? Number(limitValue) : limitValue;
        if (!Number.isInteger(limit)) throw new NotificationError('INVALID_REQUEST');
        const cursor = request.query?.cursor;
        if (cursor !== undefined && typeof cursor !== 'string')
          throw new NotificationError('INVALID_REQUEST');
        const result = await this.dependencies.service.listInbox(principal.userId, {
          limit: limit as number,
          ...(cursor === undefined ? {} : { cursor }),
        });
        return success(200, result, traceId);
      }
      const read = /^\/v1\/inbox\/([^/]+)\/read$/.exec(request.path);
      if (request.method === 'POST' && read !== null) {
        const messageId = read[1] ?? '';
        if (!UUID_V7_PATTERN.test(messageId)) throw new NotificationError('INVALID_REQUEST');
        return success(
          200,
          await this.dependencies.service.markRead(principal.userId, messageId),
          traceId,
        );
      }
      throw new HttpError('ROUTE_NOT_FOUND', 404);
    } catch (error) {
      const mapped = mapError(error);
      return {
        status: mapped.status,
        headers: { 'x-trace-id': traceId, 'content-type': 'application/json' },
        body: { code: mapped.code, message: mapped.code, traceId, retryable: mapped.retryable },
      };
    }
  }
}

class HttpError extends NotificationError {
  constructor(
    code: string,
    readonly status: number,
  ) {
    super(code);
  }
}
function success(status: number, body: unknown, traceId: string): NotificationHttpResponse {
  return { status, headers: { 'x-trace-id': traceId, 'content-type': 'application/json' }, body };
}
function mapError(error: unknown): { status: number; code: string; retryable: boolean } {
  if (error instanceof HttpError)
    return { status: error.status, code: error.code, retryable: error.retryable };
  if (error instanceof NotificationError) {
    const status =
      error.code === 'INBOX_MESSAGE_NOT_FOUND' ? 404 : error.code === 'LEASE_LOST' ? 409 : 400;
    return { status, code: error.code, retryable: error.retryable };
  }
  return { status: 500, code: 'INTERNAL_ERROR', retryable: true };
}
