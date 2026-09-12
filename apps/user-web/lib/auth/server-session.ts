import 'server-only';

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';
import { cookies } from 'next/headers';

const APP_SESSION_COOKIE_NAME = '__Host-user-session';
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const SESSION_CAPACITY = 1_000;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;

interface AccessTokenClaims {
  expiresAt: number;
  readonly ownerId: string;
  sessionId: string;
}

interface StoredSession extends AccessTokenClaims {
  accessToken: string;
  expiresAtMs: number;
  refreshToken: string;
  refreshing?: Promise<boolean>;
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

// Transitional single-process BFF storage until the shared WS09 session store is available.
// Tokens never enter browser-readable state; a distributed bounded TTL store must replace this
// before horizontal scaling.
const sessions = new Map<string, StoredSession>();

function signingKey(): string {
  const key = process.env.USER_WEB_SESSION_SIGNING_KEY;
  if (!key || key.length < 32) throw new Error('SESSION_SIGNING_KEY_UNAVAILABLE');
  return key;
}

function sign(handle: string): string {
  return createHmac('sha256', signingKey()).update(handle).digest('base64url');
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
  const payload = parseJson(Buffer.from(segments[1] ?? '', 'base64url').toString('utf8'));
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
  return { expiresAt: expiresAt as number, ownerId: ownerId.data, sessionId: sessionId.data };
}

function parseRefreshToken(value: string): string {
  if (!REFRESH_TOKEN.test(value)) throw new Error('INVALID_REFRESH_TOKEN');
  return value;
}

export function refreshTokenFromSetCookie(value: string | null): string {
  if (!value) throw new Error('REFRESH_COOKIE_REQUIRED');
  const parts = value.split(';').map((part) => part.trim());
  const first = parts.shift();
  if (!first?.startsWith('refresh_token=')) throw new Error('INVALID_REFRESH_COOKIE');
  const attributes = new Set(parts.map((part) => part.toLowerCase()));
  if (
    !attributes.has('path=/auth/refresh') ||
    !attributes.has('httponly') ||
    !attributes.has('secure') ||
    !attributes.has('samesite=lax')
  ) {
    throw new Error('INVALID_REFRESH_COOKIE');
  }
  return parseRefreshToken(decodeURIComponent(first.slice('refresh_token='.length)));
}

function prune(now = Date.now()): void {
  for (const [handle, session] of sessions) {
    if (session.expiresAtMs <= now) sessions.delete(handle);
  }
}

function decodeHandle(value: string): string | undefined {
  const [handle, signature, extra] = value.split('.');
  if (!handle || !signature || extra || !/^[A-Za-z0-9_-]{43}$/.test(handle)) return undefined;
  const expected = Buffer.from(sign(handle));
  const received = Buffer.from(signature);
  return expected.length === received.length && timingSafeEqual(expected, received)
    ? handle
    : undefined;
}

async function storedSession(): Promise<{ handle: string; session: StoredSession } | undefined> {
  prune();
  const value = (await cookies()).get(APP_SESSION_COOKIE_NAME)?.value;
  if (!value) return undefined;
  const handle = decodeHandle(value);
  const session = handle ? sessions.get(handle) : undefined;
  return handle && session ? { handle, session } : undefined;
}

async function clearSession(handle?: string): Promise<void> {
  if (handle) sessions.delete(handle);
  (await cookies()).delete(APP_SESSION_COOKIE_NAME);
}

export async function establishAuthenticatedServerSession(
  accessToken: string,
  expectedSessionId: string | undefined,
  refreshToken: string,
): Promise<void> {
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const claims = parseAccessToken(accessToken, nowSeconds);
  if (expectedSessionId !== undefined && claims.sessionId !== expectedSessionId) {
    throw new Error('GATEWAY_SESSION_MISMATCH');
  }
  prune();
  const currentCookie = (await cookies()).get(APP_SESSION_COOKIE_NAME)?.value;
  const currentHandle = currentCookie ? decodeHandle(currentCookie) : undefined;
  if (currentHandle) sessions.delete(currentHandle);
  if (sessions.size >= SESSION_CAPACITY) throw new Error('SESSION_CAPACITY_REACHED');
  const handle = randomBytes(32).toString('base64url');
  sessions.set(handle, {
    ...claims,
    accessToken,
    expiresAtMs: Date.now() + SESSION_TTL_MS,
    refreshToken: parseRefreshToken(refreshToken),
  });
  (await cookies()).set(APP_SESSION_COOKIE_NAME, `${handle}.${sign(handle)}`, {
    httpOnly: true,
    maxAge: SESSION_TTL_MS / 1_000,
    path: '/',
    sameSite: 'lax',
    secure: true,
  });
}

export async function readAuthenticatedServerSession(): Promise<
  AuthenticatedServerSession | undefined
> {
  const stored = await freshStoredSession();
  return stored ? { ownerId: stored.session.ownerId } : undefined;
}

export async function requireAuthenticatedServerSession(): Promise<AuthenticatedServerSession> {
  const session = await readAuthenticatedServerSession();
  if (!session) throw new AuthenticationRequiredError();
  return session;
}

function baseUrl(environmentName: 'GATEWAY_URL' | 'IDENTITY_SERVICE_URL'): URL {
  const configured = process.env[environmentName]?.trim();
  if (!configured) throw new Error(`${environmentName}_UNAVAILABLE`);
  return new URL(configured);
}

async function rotate(handle: string, session: StoredSession): Promise<boolean> {
  if (session.refreshing) return session.refreshing;
  session.refreshing = (async () => {
    try {
      const response = await fetch(new URL('/v1/auth/refresh', baseUrl('IDENTITY_SERVICE_URL')), {
        headers: {
          accept: 'application/json',
          cookie: `refresh_token=${encodeURIComponent(session.refreshToken)}`,
        },
        method: 'POST',
      });
      if (!response.ok) return false;
      const body = (await response.json()) as unknown;
      if (!isRecord(body) || typeof body.accessToken !== 'string') return false;
      const responseSessionId = UuidSchema.safeParse(body.sessionId);
      if (!responseSessionId.success) return false;
      const claims = parseAccessToken(body.accessToken, Math.floor(Date.now() / 1_000));
      if (claims.ownerId !== session.ownerId || claims.sessionId !== responseSessionId.data) {
        return false;
      }
      const refreshToken = refreshTokenFromSetCookie(response.headers.get('set-cookie'));
      session.accessToken = body.accessToken;
      session.refreshToken = refreshToken;
      session.expiresAt = claims.expiresAt;
      session.sessionId = claims.sessionId;
      session.expiresAtMs = Date.now() + SESSION_TTL_MS;
      return true;
    } catch {
      return false;
    } finally {
      delete session.refreshing;
    }
  })();
  const succeeded = await session.refreshing;
  if (!succeeded) await clearSession(handle);
  return succeeded;
}

async function freshStoredSession(): Promise<
  { handle: string; session: StoredSession } | undefined
> {
  const stored = await storedSession();
  if (!stored) return undefined;
  if (
    stored.session.expiresAt <= Math.floor(Date.now() / 1_000) &&
    !(await rotate(stored.handle, stored.session))
  ) {
    return undefined;
  }
  return stored;
}

export async function authenticatedGatewayFetch(
  path: `/v1/${string}`,
  init: { readonly headers?: HeadersInit; readonly signal?: AbortSignal } = {},
): Promise<Response> {
  const stored = await freshStoredSession();
  if (!stored) throw new AuthenticationRequiredError();
  const request = (token: string) => {
    const headers = new Headers(init.headers);
    headers.delete('authorization');
    headers.set('authorization', `Bearer ${token}`);
    return fetch(new URL(path, baseUrl('GATEWAY_URL')), {
      headers,
      method: 'GET',
      ...(init.signal ? { signal: init.signal } : {}),
    });
  };
  const usedToken = stored.session.accessToken;
  let response = await request(usedToken);
  if (response.status !== 401) return response;
  response.body?.cancel().catch(() => undefined);
  if (stored.session.accessToken === usedToken && !(await rotate(stored.handle, stored.session))) {
    throw new AuthenticationRequiredError();
  }
  response = await request(stored.session.accessToken);
  if (response.status === 401) await clearSession(stored.handle);
  return response;
}
