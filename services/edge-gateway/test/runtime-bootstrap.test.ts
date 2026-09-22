import type { FastifyRequest } from 'fastify';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadRuntimeConfig } from '../src/main.js';
import { createRuntimeRouteDependencies } from '../src/runtime/runtime-dependencies.js';
import { GatewayMetrics } from '../src/runtime/metrics.js';

const baseEnvironment = {
  ADMIN_JWT_PUBLIC_KEYS: '{"keys":[]}',
  CATALOG_SERVICE_URL: 'http://catalog.internal',
  CORS_ALLOWED_ORIGINS: 'https://app.example.com',
  GATEWAY_SIGNING_PRIVATE_KEY: '{}',
  GENERATION_SERVICE_URL: 'http://generation.internal',
  NOTIFICATION_SERVICE_URL: 'http://notification.internal',
  OPERATIONS_SERVICE_URL: 'http://operations.internal',
  REDIS_URL: 'rediss://redis.internal:6379',
  REPORTING_SERVICE_URL: 'http://reporting.internal',
  SERVICE_DNS_NAMES: 'catalog.internal,generation.internal',
  TRUST_PROXY_CIDRS: '10.0.0.0/8',
  USER_JWT_PUBLIC_KEYS: '{"keys":[]}',
  WALLET_SERVICE_URL: 'http://wallet.internal',
} satisfies NodeJS.ProcessEnv;

describe('production runtime assembly', () => {
  let internalPrivateJwk: Record<string, unknown>;
  let internalPublicKey: CryptoKey;
  let userPrivateKey: CryptoKey;
  let userPublicJwk: Record<string, unknown>;

  beforeAll(async () => {
    const userKeys = await generateKeyPair('EdDSA', { extractable: true });
    userPrivateKey = userKeys.privateKey;
    userPublicJwk = {
      ...(await exportJWK(userKeys.publicKey)),
      alg: 'EdDSA',
      kid: 'user-key',
    };
    const internalKeys = await generateKeyPair('EdDSA', { extractable: true });
    internalPublicKey = internalKeys.publicKey;
    internalPrivateJwk = {
      ...(await exportJWK(internalKeys.privateKey)),
      alg: 'EdDSA',
      kid: 'gateway-key',
    };
  });

  it('requires and validates service-specific base URLs', () => {
    const config = loadRuntimeConfig(baseEnvironment);

    expect(config.serviceUrls).toEqual({
      catalog: 'http://catalog.internal/',
      generation: 'http://generation.internal/',
      notification: 'http://notification.internal/',
      operations: 'http://operations.internal/',
      reporting: 'http://reporting.internal/',
      wallet: 'http://wallet.internal/',
    });
    expect(() =>
      loadRuntimeConfig({ ...baseEnvironment, GENERATION_SERVICE_URL: 'file:///tmp/socket' }),
    ).toThrow('invalid GENERATION_SERVICE_URL');
  });

  it('loads pinned keys and replaces a browser token with an internal assertion', async () => {
    const config = loadRuntimeConfig({
      ...baseEnvironment,
      ADMIN_JWT_PUBLIC_KEYS: JSON.stringify({ keys: [userPublicJwk] }),
      GATEWAY_SIGNING_PRIVATE_KEY: JSON.stringify(internalPrivateJwk),
      USER_JWT_PUBLIC_KEYS: JSON.stringify({ keys: [userPublicJwk] }),
    });
    const dependencies = await createRuntimeRouteDependencies(
      config,
      { eval: vi.fn() },
      new GatewayMetrics(),
    );
    const browserToken = await new SignJWT({ sid: 'session-1' })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'user-key' })
      .setSubject('user-1')
      .setIssuer('identity-service')
      .setAudience('user-web')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(userPrivateKey);
    const request = {
      headers: {
        authorization: `Bearer ${browserToken}`,
        'x-correlation-id': '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
        'x-trace-id': 'a'.repeat(32),
      },
    } as unknown as FastifyRequest;

    const authenticated = await dependencies.authenticateUser(request);
    const assertion = await jwtVerify(authenticated.context.subjectAssertion, internalPublicKey, {
      algorithms: ['EdDSA'],
      audience: 'internal-services',
      issuer: 'edge-gateway',
    });

    expect(authenticated.subject).toMatchObject({ kind: 'user', subjectId: 'user-1' });
    expect(assertion.payload).toMatchObject({
      correlationId: '0198f4d4-21c2-7b7d-8a03-08a0da2a51a2',
      subjectKind: 'user',
      traceId: 'a'.repeat(32),
    });
    expect(Number(assertion.payload.exp) - Number(assertion.payload.iat)).toBe(60);
    await dependencies.close();
  });
});
