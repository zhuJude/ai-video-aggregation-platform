import { PublicApiError } from '@repo/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AdminSubject, UserSubject } from '../auth/subject.js';
import type { ServiceClient, ServiceRequestContext } from '../clients/service-client.js';
import { sendGatewayError } from '../http/error-handler.js';
import type { IdempotencyClaim } from '../http/idempotency.guard.js';
import type { RateLimitIdentity, RateLimitResult, RatePolicyName } from '../limits/rate-limiter.js';
import type { AdminBff } from '../routes/admin.routes.js';
import { requireAdminPermission } from '../routes/admin.routes.js';
import type { OpenTaskEventStream, TaskEventSession } from '../routes/task-events.route.js';
import type { UserBff } from '../routes/user.routes.js';

export interface AuthenticatedRequest<TSubject extends AdminSubject | UserSubject> {
  readonly context: ServiceRequestContext;
  readonly subject: TSubject;
}

interface RouteIdempotencyGuard {
  claim(input: IdempotencyClaim): Promise<{ replay: boolean }>;
}

interface RouteRateLimiter {
  consume(policy: RatePolicyName, identity: RateLimitIdentity): Promise<RateLimitResult>;
}

interface RouteTaskEvents {
  open(input: OpenTaskEventStream): Promise<TaskEventSession>;
}

export interface GatewayRouteDependencies {
  readonly adminBff: Pick<AdminBff, 'overview'>;
  readonly authenticateAdmin: (
    request: FastifyRequest,
  ) => Promise<AuthenticatedRequest<AdminSubject>>;
  readonly authenticateUser: (
    request: FastifyRequest,
  ) => Promise<AuthenticatedRequest<UserSubject>>;
  readonly catalog: Pick<ServiceClient, 'request'>;
  readonly generation: Pick<ServiceClient, 'request'>;
  readonly idempotency: RouteIdempotencyGuard;
  readonly rateLimiter: RouteRateLimiter;
  readonly taskEvents: RouteTaskEvents;
  readonly userBff: Pick<UserBff, 'dashboard'>;
  readonly wallet: Pick<ServiceClient, 'request'>;
}

type SafeHandler = (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

function safe(handler: SafeHandler): SafeHandler {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      sendGatewayError(error, request, reply);
      return reply;
    }
  };
}

async function enforceRateLimit(
  dependencies: GatewayRouteDependencies,
  policy: RatePolicyName,
  request: FastifyRequest,
  reply: FastifyReply,
  subjectId: string,
): Promise<void> {
  const result = await dependencies.rateLimiter.consume(policy, {
    ip: request.ip,
    userId: subjectId,
  });
  if (!result.allowed) {
    void reply.header('retry-after', String(Math.max(1, result.retryAfterSeconds)));
    throw new PublicApiError('RATE_LIMITED', '请求过于频繁', true);
  }
}

function idempotencyKey(request: FastifyRequest): string | undefined {
  const value = request.headers['idempotency-key'];
  return typeof value === 'string' ? value : undefined;
}

export function registerGatewayRoutes(
  app: FastifyInstance,
  dependencies: GatewayRouteDependencies,
): void {
  app.get(
    '/v1/models',
    safe(async (request, reply) => {
      const authenticated = await dependencies.authenticateUser(request);
      await enforceRateLimit(
        dependencies,
        'catalog-read',
        request,
        reply,
        authenticated.subject.subjectId,
      );
      return dependencies.catalog.request({
        context: authenticated.context,
        method: 'GET',
        path: '/v1/models',
      });
    }),
  );
  app.get(
    '/v1/dashboard',
    safe(async (request) => {
      const authenticated = await dependencies.authenticateUser(request);
      return dependencies.userBff.dashboard(authenticated.subject, authenticated.context);
    }),
  );
  app.post(
    '/v1/tasks',
    safe(async (request, reply) => {
      const authenticated = await dependencies.authenticateUser(request);
      await enforceRateLimit(
        dependencies,
        'task-write',
        request,
        reply,
        authenticated.subject.subjectId,
      );
      const key = idempotencyKey(request);
      await dependencies.idempotency.claim({
        body: request.body,
        key,
        route: 'task-create',
        subjectId: authenticated.subject.subjectId,
      });
      const response = await dependencies.generation.request({
        body: request.body,
        context: authenticated.context,
        ...(key === undefined ? {} : { idempotencyKey: key }),
        method: 'POST',
        path: '/v1/tasks',
      });
      return reply.status(202).send(response);
    }),
  );
  app.get(
    '/admin/v1/overview',
    safe(async (request) => {
      const authenticated = await dependencies.authenticateAdmin(request);
      requireAdminPermission(authenticated.subject, 'reporting:read');
      return dependencies.adminBff.overview(authenticated.subject, authenticated.context);
    }),
  );
  app.post(
    '/admin/v1/wallet/adjustments',
    safe(async (request, reply) => {
      const authenticated = await dependencies.authenticateAdmin(request);
      requireAdminPermission(authenticated.subject, 'wallet:adjust');
      await enforceRateLimit(
        dependencies,
        'point-adjustment',
        request,
        reply,
        authenticated.subject.subjectId,
      );
      const key = idempotencyKey(request);
      await dependencies.idempotency.claim({
        body: request.body,
        key,
        route: 'point-adjustment',
        subjectId: authenticated.subject.subjectId,
      });
      const response = await dependencies.wallet.request({
        body: request.body,
        context: authenticated.context,
        ...(key === undefined ? {} : { idempotencyKey: key }),
        method: 'POST',
        path: '/admin/v1/wallet/adjustments',
      });
      return reply.status(202).send(response);
    }),
  );
  app.get(
    '/v1/tasks/:taskId/events',
    safe(async (request, reply) => {
      const authenticated = await dependencies.authenticateUser(request);
      const client = new AbortController();
      request.raw.once('close', () => {
        client.abort();
      });
      const incomingLastEventId = request.headers['last-event-id'];
      const session = await dependencies.taskEvents.open({
        clientSignal: client.signal,
        context: authenticated.context,
        ...(typeof incomingLastEventId === 'string' ? { lastEventId: incomingLastEventId } : {}),
        taskId: (request.params as { taskId: string }).taskId,
        userId: authenticated.subject.subjectId,
      });
      reply.hijack();
      reply.raw.writeHead(200, session.headers);
      session.stream.pipe(reply.raw);
      return reply;
    }),
  );
}
