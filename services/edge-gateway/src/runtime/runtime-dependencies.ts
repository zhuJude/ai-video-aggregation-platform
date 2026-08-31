import { randomBytes, randomUUID } from 'node:crypto';
import { HEADERS } from '@repo/contracts/common';
import { PublicApiError } from '@repo/service-kit';
import type { FastifyRequest } from 'fastify';
import { importJWK, type CryptoKey, type JWK } from 'jose';
import type { RuntimeConfig } from '../main.js';
import type { AdminSubject, AuthenticatedSubject, UserSubject } from '../auth/subject.js';
import { TokenVerifier } from '../auth/token-verifier.js';
import { ServiceClient, type ServiceRequestContext } from '../clients/service-client.js';
import { IdempotencyGuard } from '../http/idempotency.guard.js';
import { RateLimiter, type RedisScriptClient } from '../limits/rate-limiter.js';
import { AdminBff } from '../routes/admin.routes.js';
import { TaskEventsRoute } from '../routes/task-events.route.js';
import { UserBff } from '../routes/user.routes.js';
import { GenerationTaskOwnership, GenerationTaskStreamSource } from './generation-events.js';
import type { AuthenticatedRequest, GatewayRouteDependencies } from './gateway-routes.js';
import type { GatewayMetrics } from './metrics.js';

interface ImportedKeys {
  readonly algorithms: string[];
  readonly keys: Map<string, CryptoKey>;
}

interface JsonWebKeySet {
  readonly keys: JWK[];
}

export interface RuntimeRouteDependencies extends GatewayRouteDependencies {
  close(): Promise<void>;
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`invalid ${label}`);
  }
}

function isJwk(value: unknown): value is JWK & { alg: string; kid: string } {
  return (
    value !== null &&
    typeof value === 'object' &&
    'alg' in value &&
    typeof value.alg === 'string' &&
    value.alg.length > 0 &&
    value.alg !== 'none' &&
    'kid' in value &&
    typeof value.kid === 'string' &&
    value.kid.length > 0 &&
    'kty' in value &&
    typeof value.kty === 'string' &&
    value.kty !== 'oct'
  );
}

async function importAsymmetricJwk(jwk: JWK & { alg: string; kid: string }): Promise<CryptoKey> {
  const key = await importJWK(jwk, jwk.alg);
  if (key instanceof Uint8Array) throw new Error('symmetric keys are not accepted');
  return key;
}

async function importPublicKeys(raw: string, label: string): Promise<ImportedKeys> {
  const document = parseJson(raw, label) as Partial<JsonWebKeySet>;
  if (!Array.isArray(document.keys) || document.keys.length === 0) {
    throw new Error(`invalid ${label}`);
  }
  const keys = new Map<string, CryptoKey>();
  const algorithms = new Set<string>();
  for (const candidate of document.keys) {
    if (!isJwk(candidate) || keys.has(candidate.kid) || 'd' in candidate) {
      throw new Error(`invalid ${label}`);
    }
    keys.set(candidate.kid, await importAsymmetricJwk(candidate));
    algorithms.add(candidate.alg);
  }
  return { algorithms: [...algorithms], keys };
}

async function importSigningKey(raw: string): Promise<{
  algorithm: string;
  kid: string;
  privateKey: CryptoKey;
}> {
  const candidate = parseJson(raw, 'GATEWAY_SIGNING_PRIVATE_KEY');
  if (!isJwk(candidate) || !('d' in candidate)) {
    throw new Error('invalid GATEWAY_SIGNING_PRIVATE_KEY');
  }
  return {
    algorithm: candidate.alg,
    kid: candidate.kid,
    privateKey: await importAsymmetricJwk(candidate),
  };
}

function requestToken(request: FastifyRequest, code: string): string {
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/.exec(authorization) : null;
  if (match?.[1] === undefined) {
    throw new PublicApiError(code, '身份令牌无效', false);
  }
  return match[1];
}

function requestContext(request: FastifyRequest): Omit<ServiceRequestContext, 'subjectAssertion'> {
  const incomingTraceId = request.headers[HEADERS.traceId];
  const traceId =
    typeof incomingTraceId === 'string' && /^[a-f0-9]{32}$/.test(incomingTraceId)
      ? incomingTraceId
      : randomBytes(16).toString('hex');
  const incomingCorrelationId = request.headers[HEADERS.correlationId];
  const correlationId =
    typeof incomingCorrelationId === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      incomingCorrelationId,
    )
      ? incomingCorrelationId
      : randomUUID();
  return { correlationId, traceId };
}

function card(
  client: ServiceClient,
  path: string,
): {
  get(_subject: AuthenticatedSubject, context: ServiceRequestContext): Promise<object>;
};
function card(client: ServiceClient, path: string) {
  return {
    get: (_subject: AuthenticatedSubject, context: ServiceRequestContext) =>
      client.request<object>({ context, method: 'GET', path }),
  };
}

export async function createRuntimeRouteDependencies(
  config: RuntimeConfig,
  redis: RedisScriptClient,
  metrics: GatewayMetrics,
): Promise<RuntimeRouteDependencies> {
  const [userKeys, adminKeys, signingKey] = await Promise.all([
    importPublicKeys(config.userJwtPublicKeys, 'USER_JWT_PUBLIC_KEYS'),
    importPublicKeys(config.adminJwtPublicKeys, 'ADMIN_JWT_PUBLIC_KEYS'),
    importSigningKey(config.gatewaySigningPrivateKey),
  ]);
  const verifier = new TokenVerifier({
    admin: {
      algorithms: adminKeys.algorithms,
      audience: 'admin-web',
      issuer: 'iam-service',
      keys: adminKeys.keys,
    },
    internalSigner: {
      ...signingKey,
      audience: 'internal-services',
      issuer: 'edge-gateway',
    },
    user: {
      algorithms: userKeys.algorithms,
      audience: 'user-web',
      issuer: 'identity-service',
      keys: userKeys.keys,
    },
  });
  const serviceClient = (baseUrl: string): ServiceClient =>
    new ServiceClient({
      baseUrl,
      onCircuitOpen: () => {
        metrics.incrementCircuitOpen();
      },
      onTimeout: () => {
        metrics.incrementUpstreamTimeout();
      },
    });
  const clients = {
    catalog: serviceClient(config.serviceUrls.catalog),
    generation: serviceClient(config.serviceUrls.generation),
    notification: serviceClient(config.serviceUrls.notification),
    operations: serviceClient(config.serviceUrls.operations),
    reporting: serviceClient(config.serviceUrls.reporting),
    wallet: serviceClient(config.serviceUrls.wallet),
  };

  const authenticate = async <TSubject extends AdminSubject | UserSubject>(
    request: FastifyRequest,
    kind: TSubject['kind'],
  ): Promise<AuthenticatedRequest<TSubject>> => {
    try {
      const subject =
        kind === 'user'
          ? await verifier.verifyUser(requestToken(request, 'INVALID_USER_TOKEN'))
          : await verifier.verifyAdmin(requestToken(request, 'INVALID_ADMIN_TOKEN'));
      const context = requestContext(request);
      return {
        context: {
          ...context,
          subjectAssertion: await verifier.createInternalSubjectAssertion(subject, context),
        },
        subject: subject as TSubject,
      };
    } catch {
      metrics.incrementAuthDenial();
      throw new PublicApiError(
        kind === 'user' ? 'INVALID_USER_TOKEN' : 'INVALID_ADMIN_TOKEN',
        '身份令牌无效',
        false,
      );
    }
  };
  const limiter = new RateLimiter(redis);
  const rateLimiter = {
    consume: async (...input: Parameters<RateLimiter['consume']>) => {
      const result = await limiter.consume(...input);
      if (!result.allowed) metrics.incrementRateLimitRejection();
      return result;
    },
  };
  const streamSource = new GenerationTaskStreamSource(config.serviceUrls.generation);
  const taskEvents = new TaskEventsRoute(
    new GenerationTaskOwnership(clients.generation),
    streamSource,
    {
      onActiveConnectionsChanged: (count) => {
        metrics.setActiveSseStreams(count);
      },
    },
  );

  return {
    adminBff: new AdminBff({
      alerts: card(clients.operations, '/admin/v1/alerts?active=true'),
      reporting: card(clients.reporting, '/admin/v1/overview'),
    }),
    authenticateAdmin: (request) => authenticate<AdminSubject>(request, 'admin'),
    authenticateUser: (request) => authenticate<UserSubject>(request, 'user'),
    catalog: clients.catalog,
    close: async () => {
      await Promise.all([
        ...Object.values(clients).map((client) => client.close()),
        streamSource.close(),
      ]);
    },
    generation: clients.generation,
    idempotency: new IdempotencyGuard(redis),
    rateLimiter,
    taskEvents,
    userBff: new UserBff({
      messages: card(clients.notification, '/v1/messages?limit=5'),
      tasks: card(clients.generation, '/v1/tasks?limit=5'),
      wallet: card(clients.wallet, '/v1/wallet'),
    }),
    wallet: clients.wallet,
  };
}
