import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';
import { cookies } from 'next/headers';

const APP_SESSION_COOKIE_NAME = '__Host-user-session';
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

interface AccessTokenClaims {
  readonly expiresAt: number;
  readonly ownerId: string;
  readonly sessionId: string;
}

interface AppSessionPayload extends AccessTokenClaims {
  readonly version: 1;
}

export interface AuthenticatedServerSession {
  readonly ownerId: string;
}

export class AuthenticationRequiredError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;

  constructor() {
    super('AUTHENTICATION_REQUIRED');
  }
}

function signingKey(): string {
  const key = process.env.USER_WEB_SESSION_SIGNING_KEY;
  if (!key || key.length < 32) throw new Error('SESSION_SIGNING_KEY_UNAVAILABLE');
  return key;
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', signingKey()).update(encodedPayload).digest('base64url');
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseAccessToken(accessToken: string, nowSeconds: number): AccessTokenClaims {
  const segments = accessToken.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  }
  const payloadSegment = segments[1];
  if (!payloadSegment) throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const payload = parseJson(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  if (!isRecord(payload)) throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const ownerId = UuidSchema.safeParse(payload.sub);
  const sessionId = UuidSchema.safeParse(payload.sid);
  const expiresAt = payload.exp;
  if (
    !ownerId.success ||
    !sessionId.success ||
    payload.iss !== 'identity-service' ||
    payload.aud !== 'user-web' ||
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= nowSeconds ||
    (expiresAt as number) > nowSeconds + MAX_ACCESS_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  }
  return {
    expiresAt: expiresAt as number,
    ownerId: ownerId.data,
    sessionId: sessionId.data,
  };
}

function parseAppSession(value: string, nowSeconds: number): AppSessionPayload | undefined {
  const segments = value.split('.');
  if (segments.length !== 2) return undefined;
  const [encodedPayload, signature] = segments;
  if (!encodedPayload || !signature) return undefined;
  const expected = Buffer.from(sign(encodedPayload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return undefined;
  const payload = parseJson(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  if (
    !isRecord(payload) ||
    Object.keys(payload).some(
      (key) => !['version', 'expiresAt', 'ownerId', 'sessionId'].includes(key),
    )
  ) {
    return undefined;
  }
  const ownerId = UuidSchema.safeParse(payload.ownerId);
  const sessionId = UuidSchema.safeParse(payload.sessionId);
  if (
    payload.version !== 1 ||
    !ownerId.success ||
    !sessionId.success ||
    !Number.isSafeInteger(payload.expiresAt) ||
    (payload.expiresAt as number) <= nowSeconds
  ) {
    return undefined;
  }
  return {
    version: 1,
    expiresAt: payload.expiresAt as number,
    ownerId: ownerId.data,
    sessionId: sessionId.data,
  };
}

export async function establishAuthenticatedServerSession(
  accessToken: string,
  expectedSessionId?: string,
): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const claims = parseAccessToken(accessToken, nowSeconds);
  if (expectedSessionId !== undefined && claims.sessionId !== expectedSessionId) {
    throw new Error('GATEWAY_SESSION_MISMATCH');
  }
  const encodedPayload = Buffer.from(JSON.stringify({ version: 1, ...claims })).toString(
    'base64url',
  );
  (await cookies()).set(APP_SESSION_COOKIE_NAME, `${encodedPayload}.${sign(encodedPayload)}`, {
    httpOnly: true,
    maxAge: claims.expiresAt - nowSeconds,
    path: '/',
    sameSite: 'lax',
    secure: true,
  });
}

export async function readAuthenticatedServerSession(): Promise<
  AuthenticatedServerSession | undefined
> {
  const value = (await cookies()).get(APP_SESSION_COOKIE_NAME)?.value;
  if (!value) return undefined;
  const payload = parseAppSession(value, Math.floor(Date.now() / 1_000));
  return payload ? { ownerId: payload.ownerId } : undefined;
}

export async function requireAuthenticatedServerSession(): Promise<AuthenticatedServerSession> {
  const session = await readAuthenticatedServerSession();

  if (!session) throw new AuthenticationRequiredError();
  return session;
}
