import 'server-only';

import {
  createCipheriv,
  createDecipheriv,
  createPublicKey,
  randomBytes,
  verify,
} from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';
import { cookies } from 'next/headers';

import {
  resolveCurrentVerifiedPhoneForMockSubject,
  resolveExistingMockSubjectForVerifiedPhone,
  resolveOrCreateMockSubjectForVerifiedPhone,
} from './mock-subject-store';
import {
  registerAccountSession,
  rotateAccountSession,
  validateAccountSession,
} from '../account/mock-store';
import { isUuidV7 } from '../tasks/identifiers';

const APP_SESSION_COOKIE_NAME = '__Host-user-session';
const COOKIE_VERSION = 'v3';
const MAX_COOKIE_BYTES = 3_800;
const MAX_ACCESS_TOKEN_BYTES = 3_000;
const MAX_ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const REFRESH_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const VERIFIED_PHONE_OWNER = /^\+861[3-9]\d{9}$/;

interface AccessTokenMetadata {
  readonly expiresAt: number;
  readonly sessionId: string;
}

interface VerifiedAccessTokenMetadata extends AccessTokenMetadata {
  readonly ownerId: string;
}

interface StoredSession {
  readonly accessToken: string;
  readonly accessExpiresAt: number;
  readonly expiresAt: number;
  readonly issuedAt: number;
  readonly ownerId: string;
  readonly sessionId: string;
  readonly verifiedPhone: string;
  readonly version: 3;
}

export interface AuthenticatedServerSession {
  readonly ownerId: string;
}

export interface AuthenticatedServerSessionIdentity extends AuthenticatedServerSession {
  readonly sessionId: string;
  readonly verifiedPhone: string;
}

export type AuthenticatedServerSessionState =
  | { readonly kind: 'active'; readonly session: AuthenticatedServerSession }
  | { readonly kind: 'needs-refresh' }
  | { readonly kind: 'invalid' };

export class AuthenticationRequiredError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;

  constructor() {
    super('AUTHENTICATION_REQUIRED');
  }
}

export class SessionRefreshRequiredError extends Error {
  constructor() {
    super('SESSION_REFRESH_REQUIRED');
  }
}

function encryptionKey(): Buffer {
  const encoded = process.env.USER_WEB_SESSION_ENCRYPTION_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error('SESSION_ENCRYPTION_KEY_UNAVAILABLE');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) {
    throw new Error('SESSION_ENCRYPTION_KEY_UNAVAILABLE');
  }
  return key;
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

// The access token is opaque authorization material. Unverified metadata is used only to
// schedule refresh and cross-check the WS10 response; it never selects the local fixture owner.
function parseAccessTokenMetadata(accessToken: string, nowSeconds: number): AccessTokenMetadata {
  if (Buffer.byteLength(accessToken) > MAX_ACCESS_TOKEN_BYTES) {
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  }
  const segments = accessToken.split('.');
  if (segments.length !== 3 || segments.some((segment) => segment.length === 0)) {
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  }
  const payload = parseJson(Buffer.from(segments[1] ?? '', 'base64url').toString('utf8'));
  if (!isRecord(payload)) throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const sessionId = UuidSchema.safeParse(payload.sid);
  const expiresAt = payload.exp;
  if (
    !sessionId.success ||
    payload.iss !== 'identity-service' ||
    payload.aud !== 'user-web' ||
    !Number.isSafeInteger(expiresAt) ||
    (expiresAt as number) <= nowSeconds ||
    (expiresAt as number) > nowSeconds + MAX_ACCESS_TOKEN_LIFETIME_SECONDS
  ) {
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  }
  return { expiresAt: expiresAt as number, sessionId: sessionId.data };
}

function decodeBase64Url(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const decoded = Buffer.from(segment, 'base64url');
  if (decoded.toString('base64url') !== segment) throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  return decoded;
}

function configuredVerificationKeys(): ReadonlyMap<string, ReturnType<typeof createPublicKey>> {
  const configured = process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON;
  if (!configured || Buffer.byteLength(configured) > 16_384)
    throw new Error('IDENTITY_VERIFY_KEYS_UNAVAILABLE');
  const parsed = parseJson(configured);
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 5)
    throw new Error('IDENTITY_VERIFY_KEYS_UNAVAILABLE');
  const seen = new Set<string>();
  const keys = new Map<string, ReturnType<typeof createPublicKey>>();
  for (const raw of parsed) {
    if (!isRecord(raw) || Object.keys(raw).sort().join(',') !== 'kid,spki')
      throw new Error('IDENTITY_VERIFY_KEYS_UNAVAILABLE');
    if (
      typeof raw.kid !== 'string' ||
      !/^[A-Za-z0-9._:-]{1,128}$/.test(raw.kid) ||
      seen.has(raw.kid) ||
      typeof raw.spki !== 'string' ||
      raw.spki.length > 2_048
    )
      throw new Error('IDENTITY_VERIFY_KEYS_UNAVAILABLE');
    seen.add(raw.kid);
    try {
      const der = decodeBase64Url(raw.spki);
      const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
      if (key.asymmetricKeyType !== 'ed25519') throw new Error('INVALID_KEY_TYPE');
      keys.set(raw.kid, key);
    } catch {
      throw new Error('IDENTITY_VERIFY_KEYS_UNAVAILABLE');
    }
  }
  return keys;
}

function verificationKey(keyId: string) {
  const key = configuredVerificationKeys().get(keyId);
  if (!key) throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  return key;
}

export function identityVerificationConfigurationReady(): boolean {
  try {
    return configuredVerificationKeys().size > 0;
  } catch {
    return false;
  }
}

// WS10 signs access tokens with an Ed25519 KMS key. Deployments provide this web
// process only the matching public SPKI keyring; no private or mock identity key is used.
function verifyAccessTokenMetadata(
  accessToken: string,
  nowSeconds: number,
): VerifiedAccessTokenMetadata {
  if (Buffer.byteLength(accessToken) > MAX_ACCESS_TOKEN_BYTES)
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const [encodedHeader, encodedPayload, encodedSignature, extra] = accessToken.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature || extra)
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const header = parseJson(decodeBase64Url(encodedHeader).toString('utf8'));
  const payload = parseJson(decodeBase64Url(encodedPayload).toString('utf8'));
  if (!isRecord(header) || !isRecord(payload)) throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  if (
    Object.keys(header).sort().join(',') !== 'alg,kid,typ' ||
    header.alg !== 'EdDSA' ||
    header.typ !== 'JWT' ||
    typeof header.kid !== 'string' ||
    !/^[A-Za-z0-9._:-]{1,128}$/.test(header.kid)
  )
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const allowedClaims = new Set(['aud', 'exp', 'iat', 'iss', 'nbf', 'sid', 'sub']);
  if (Object.keys(payload).some((claim) => !allowedClaims.has(claim)))
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const signature = decodeBase64Url(encodedSignature);
  if (
    signature.length !== 64 ||
    !verify(
      null,
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      verificationKey(header.kid),
      signature,
    )
  )
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  const expiresAt = payload.exp;
  const issuedAt = payload.iat;
  const notBefore = payload.nbf;
  if (
    payload.iss !== 'identity-service' ||
    payload.aud !== 'user-web' ||
    !isUuidV7(payload.sub) ||
    !isUuidV7(payload.sid) ||
    !Number.isSafeInteger(issuedAt) ||
    !Number.isSafeInteger(expiresAt) ||
    (issuedAt as number) > nowSeconds + 30 ||
    (expiresAt as number) <= nowSeconds ||
    (expiresAt as number) <= (issuedAt as number) ||
    (expiresAt as number) - (issuedAt as number) > MAX_ACCESS_TOKEN_LIFETIME_SECONDS ||
    (notBefore !== undefined &&
      (!Number.isSafeInteger(notBefore) || (notBefore as number) > nowSeconds))
  )
    throw new Error('INVALID_GATEWAY_ACCESS_TOKEN');
  return {
    expiresAt: expiresAt as number,
    sessionId: payload.sid,
    ownerId: payload.sub,
  };
}

function validateSession(value: unknown, nowSeconds: number): StoredSession | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (
    keys.join(',') !==
    'accessExpiresAt,accessToken,expiresAt,issuedAt,ownerId,sessionId,verifiedPhone,version'
  ) {
    return undefined;
  }
  const sessionId = UuidSchema.safeParse(value.sessionId);
  if (
    value.version !== 3 ||
    typeof value.accessToken !== 'string' ||
    Buffer.byteLength(value.accessToken) > MAX_ACCESS_TOKEN_BYTES ||
    !isUuidV7(value.ownerId) ||
    typeof value.verifiedPhone !== 'string' ||
    !VERIFIED_PHONE_OWNER.test(value.verifiedPhone) ||
    !sessionId.success ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(value.accessExpiresAt)
  ) {
    return undefined;
  }
  const issuedAt = value.issuedAt as number;
  const expiresAt = value.expiresAt as number;
  if (
    issuedAt > nowSeconds + 60 ||
    expiresAt <= nowSeconds ||
    expiresAt <= issuedAt ||
    expiresAt > issuedAt + SESSION_TTL_SECONDS ||
    (value.accessExpiresAt as number) <= issuedAt ||
    (value.accessExpiresAt as number) > issuedAt + MAX_ACCESS_TOKEN_LIFETIME_SECONDS ||
    (value.accessExpiresAt as number) > expiresAt
  ) {
    return undefined;
  }
  return {
    version: 3,
    accessToken: value.accessToken,
    accessExpiresAt: value.accessExpiresAt as number,
    expiresAt,
    issuedAt,
    ownerId: value.ownerId,
    sessionId: sessionId.data,
    verifiedPhone: value.verifiedPhone,
  };
}

function encryptSession(session: StoredSession): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), nonce);
  cipher.setAAD(Buffer.from(`${APP_SESSION_COOKIE_NAME}:${COOKIE_VERSION}`));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(session), 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const value = `${COOKIE_VERSION}.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}`;
  if (Buffer.byteLength(value) > MAX_COOKIE_BYTES) throw new Error('SESSION_COOKIE_TOO_LARGE');
  return value;
}

function decryptSession(value: string, nowSeconds: number): StoredSession | undefined {
  try {
    if (Buffer.byteLength(value) > MAX_COOKIE_BYTES) return undefined;
    const [version, encodedNonce, encodedCiphertext, extra] = value.split('.');
    if (version !== COOKIE_VERSION || !encodedNonce || !encodedCiphertext || extra)
      return undefined;
    const nonce = Buffer.from(encodedNonce, 'base64url');
    const encrypted = Buffer.from(encodedCiphertext, 'base64url');
    if (nonce.length !== 12 || encrypted.length <= 16) return undefined;
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), nonce);
    decipher.setAAD(Buffer.from(`${APP_SESSION_COOKIE_NAME}:${COOKIE_VERSION}`));
    decipher.setAuthTag(encrypted.subarray(encrypted.length - 16));
    const plaintext = Buffer.concat([
      decipher.update(encrypted.subarray(0, encrypted.length - 16)),
      decipher.final(),
    ]).toString('utf8');
    return validateSession(parseJson(plaintext), nowSeconds);
  } catch {
    return undefined;
  }
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
  const token = decodeURIComponent(first.slice('refresh_token='.length));
  if (!REFRESH_TOKEN.test(token)) throw new Error('INVALID_REFRESH_COOKIE');
  return token;
}

async function writeSession(session: StoredSession): Promise<void> {
  (await cookies()).set(APP_SESSION_COOKIE_NAME, encryptSession(session), {
    httpOnly: true,
    maxAge: Math.max(0, session.expiresAt - Math.floor(Date.now() / 1_000)),
    path: '/',
    sameSite: 'lax',
    secure: true,
  });
}

async function writeRefreshToken(refreshToken: string): Promise<void> {
  if (!REFRESH_TOKEN.test(refreshToken)) throw new Error('INVALID_REFRESH_TOKEN');
  (await cookies()).set('refresh_token', refreshToken, {
    httpOnly: true,
    maxAge: SESSION_TTL_SECONDS,
    path: '/auth/refresh',
    sameSite: 'lax',
    secure: true,
  });
}

async function clearSession(): Promise<void> {
  const jar = await cookies();
  jar.delete(APP_SESSION_COOKIE_NAME);
  // Cookie deletion must repeat the original Path or the scoped credential survives.
  jar.set('refresh_token', '', {
    httpOnly: true,
    maxAge: 0,
    path: '/auth/refresh',
    sameSite: 'lax',
    secure: true,
  });
}

async function storedSession(): Promise<StoredSession | undefined> {
  const value = (await cookies()).get(APP_SESSION_COOKIE_NAME)?.value;
  return value ? decryptSession(value, Math.floor(Date.now() / 1_000)) : undefined;
}

async function validateLiveSession(session: StoredSession): Promise<boolean> {
  try {
    const headers = gatewayMetadataHeaders({
      accept: 'application/json',
      authorization: `Bearer ${session.accessToken}`,
    });
    const response = await fetch(new URL('/v1/sessions', baseUrl('GATEWAY_URL')), {
      headers,
      method: 'GET',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body) || body.length > 100) return false;
    const sessions = body.map((raw) => {
      if (
        !isRecord(raw) ||
        Object.keys(raw).sort().join(',') !== 'createdAt,deviceName,expiresAt,id' ||
        !isUuidV7(raw.id) ||
        typeof raw.deviceName !== 'string' ||
        !raw.deviceName.trim() ||
        raw.deviceName.length > 120 ||
        typeof raw.createdAt !== 'string' ||
        typeof raw.expiresAt !== 'string' ||
        !Number.isFinite(Date.parse(raw.createdAt)) ||
        !Number.isFinite(Date.parse(raw.expiresAt))
      )
        throw new Error('INVALID_LIVE_SESSION_LIST');
      return { id: raw.id, expiresAt: raw.expiresAt };
    });
    return sessions.some(
      ({ id, expiresAt }) => id === session.sessionId && Date.parse(expiresAt) > Date.now(),
    );
  } catch {
    return false;
  }
}

async function durableSessionIdentity(
  session: StoredSession,
): Promise<{ readonly verifiedPhone: string } | undefined> {
  if (process.env.USER_WEB_SUPPORT_MODE !== 'mock') {
    return (await validateLiveSession(session))
      ? { verifiedPhone: session.verifiedPhone }
      : undefined;
  }
  try {
    await validateAccountSession(session.ownerId, session.sessionId);
    const verifiedPhone = await resolveCurrentVerifiedPhoneForMockSubject(session.ownerId);
    const mappedSubject = await resolveExistingMockSubjectForVerifiedPhone(verifiedPhone);
    return mappedSubject === session.ownerId ? { verifiedPhone } : undefined;
  } catch {
    return undefined;
  }
}

export async function establishAuthenticatedServerSession(
  accessToken: string,
  expectedSessionId: string,
  refreshToken: string,
  verifiedPhoneOwner: string,
): Promise<void> {
  if (!VERIFIED_PHONE_OWNER.test(verifiedPhoneOwner)) throw new Error('INVALID_VERIFIED_OWNER');
  const nowSeconds = Math.floor(Date.now() / 1_000);
  const mockMode = process.env.USER_WEB_SUPPORT_MODE === 'mock';
  const metadata = mockMode
    ? parseAccessTokenMetadata(accessToken, nowSeconds)
    : verifyAccessTokenMetadata(accessToken, nowSeconds);
  if (metadata.sessionId !== expectedSessionId) throw new Error('GATEWAY_SESSION_MISMATCH');
  if (!REFRESH_TOKEN.test(refreshToken)) throw new Error('INVALID_REFRESH_TOKEN');
  const ownerId = mockMode
    ? await resolveOrCreateMockSubjectForVerifiedPhone(verifiedPhoneOwner)
    : (metadata as VerifiedAccessTokenMetadata).ownerId;
  if (mockMode) {
    await registerAccountSession(ownerId, metadata.sessionId, verifiedPhoneOwner);
  }
  await writeSession({
    version: 3,
    accessToken,
    accessExpiresAt: metadata.expiresAt,
    expiresAt: nowSeconds + SESSION_TTL_SECONDS,
    issuedAt: nowSeconds,
    ownerId,
    sessionId: metadata.sessionId,
    verifiedPhone: verifiedPhoneOwner,
  });
  await writeRefreshToken(refreshToken);
}

// RSC callers use this read-only path. They never rotate or mutate cookies during render.
export async function readAuthenticatedServerSession(): Promise<
  AuthenticatedServerSession | undefined
> {
  const state = await readAuthenticatedServerSessionState();
  return state.kind === 'active' ? state.session : undefined;
}

export async function readAuthenticatedServerSessionState(): Promise<AuthenticatedServerSessionState> {
  const session = await storedSession();
  if (!session) return { kind: 'invalid' };
  if (session.accessExpiresAt <= Math.floor(Date.now() / 1_000)) {
    if (process.env.USER_WEB_SUPPORT_MODE === 'mock' && !(await durableSessionIdentity(session)))
      return { kind: 'invalid' };
    // In live mode the refresh endpoint is the authority for an expired access token;
    // no protected data is returned before that explicit mutation succeeds.
    return { kind: 'needs-refresh' };
  }
  if (!(await durableSessionIdentity(session))) return { kind: 'invalid' };
  return { kind: 'active', session: { ownerId: session.ownerId } };
}

export async function requireAuthenticatedServerSession(): Promise<AuthenticatedServerSession> {
  const session = await readAuthenticatedServerSession();
  if (!session) throw new AuthenticationRequiredError();
  return session;
}

function baseUrl(environmentName: 'GATEWAY_URL'): URL {
  const configured = process.env[environmentName]?.trim();
  if (!configured) throw new Error(`${environmentName}_UNAVAILABLE`);
  return new URL(configured);
}

function gatewayMetadataHeaders(input?: HeadersInit): Headers {
  const headers = new Headers(input);
  if (!headers.has('x-correlation-id')) headers.set('x-correlation-id', crypto.randomUUID());
  if (!headers.has('x-trace-id')) headers.set('x-trace-id', randomBytes(16).toString('hex'));
  return headers;
}

async function rotate(session: StoredSession): Promise<StoredSession | undefined> {
  try {
    const nowBeforeRefresh = Math.floor(Date.now() / 1_000);
    const durableBefore =
      process.env.USER_WEB_SUPPORT_MODE === 'mock' || session.accessExpiresAt > nowBeforeRefresh
        ? await durableSessionIdentity(session)
        : { verifiedPhone: session.verifiedPhone };
    if (!durableBefore) return undefined;
    const refreshToken = (await cookies()).get('refresh_token')?.value;
    if (!refreshToken || !REFRESH_TOKEN.test(refreshToken)) return undefined;
    const headers = gatewayMetadataHeaders();
    headers.set('accept', 'application/json');
    headers.set('cookie', `refresh_token=${encodeURIComponent(refreshToken)}`);
    const response = await fetch(new URL('/v1/auth/refresh', baseUrl('GATEWAY_URL')), {
      headers,
      method: 'POST',
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const body = (await response.json()) as unknown;
    if (!isRecord(body) || typeof body.accessToken !== 'string') return undefined;
    const responseSessionId = UuidSchema.safeParse(body.sessionId);
    if (!responseSessionId.success) return undefined;
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const metadata =
      process.env.USER_WEB_SUPPORT_MODE === 'mock'
        ? parseAccessTokenMetadata(body.accessToken, nowSeconds)
        : verifyAccessTokenMetadata(body.accessToken, nowSeconds);
    if (metadata.sessionId !== responseSessionId.data) return undefined;
    if (
      process.env.USER_WEB_SUPPORT_MODE !== 'mock' &&
      (metadata as VerifiedAccessTokenMetadata).ownerId !== session.ownerId
    )
      return undefined;
    let verifiedPhone = durableBefore.verifiedPhone;
    if (process.env.USER_WEB_SUPPORT_MODE === 'mock') {
      // This transaction is the second authorization check: a concurrent revoke/close
      // between the upstream refresh and this point cannot resurrect the session.
      await rotateAccountSession(session.ownerId, session.sessionId, metadata.sessionId);
      // The account file is only a cache. A phone rebind may have committed even if
      // updating that cache failed, so refresh must always re-read the authoritative
      // subject binding before minting the replacement cookie.
      verifiedPhone = await resolveCurrentVerifiedPhoneForMockSubject(session.ownerId);
    } else {
      const liveCandidate: StoredSession = {
        ...session,
        accessToken: body.accessToken,
        accessExpiresAt: metadata.expiresAt,
        sessionId: metadata.sessionId,
      };
      if (!(await validateLiveSession(liveCandidate))) return undefined;
    }
    const rotated: StoredSession = {
      version: 3,
      accessToken: body.accessToken,
      accessExpiresAt: metadata.expiresAt,
      expiresAt: nowSeconds + SESSION_TTL_SECONDS,
      issuedAt: nowSeconds,
      ownerId: session.ownerId,
      sessionId: metadata.sessionId,
      verifiedPhone,
    };
    await writeSession(rotated);
    await writeRefreshToken(refreshTokenFromSetCookie(response.headers.get('set-cookie')));
    return rotated;
  } catch {
    return undefined;
  }
}

async function mutableFreshSession(): Promise<StoredSession | undefined> {
  const session = await storedSession();
  if (!session) return undefined;
  if (!(await durableSessionIdentity(session))) return undefined;
  return session.accessExpiresAt > Math.floor(Date.now() / 1_000) ? session : undefined;
}

export async function requireMutableAuthenticatedServerSession(): Promise<AuthenticatedServerSession> {
  const session = await mutableFreshSession();
  if (!session) {
    const state = await readAuthenticatedServerSessionState();
    if (state.kind === 'needs-refresh') throw new SessionRefreshRequiredError();
    throw new AuthenticationRequiredError();
  }
  return { ownerId: session.ownerId };
}

export async function requireMutableAuthenticatedServerSessionIdentity(): Promise<AuthenticatedServerSessionIdentity> {
  const session = await mutableFreshSession();
  if (!session) {
    const state = await readAuthenticatedServerSessionState();
    if (state.kind === 'needs-refresh') throw new SessionRefreshRequiredError();
    throw new AuthenticationRequiredError();
  }
  const durable = await durableSessionIdentity(session);
  if (!durable) throw new AuthenticationRequiredError();
  return {
    ownerId: session.ownerId,
    sessionId: session.sessionId,
    verifiedPhone: durable.verifiedPhone,
  };
}

export async function replaceAuthenticatedServerSessionPhone(
  expectedSubjectId: string,
  verifiedPhone: string,
): Promise<void> {
  if (
    !UuidSchema.safeParse(expectedSubjectId).success ||
    !VERIFIED_PHONE_OWNER.test(verifiedPhone)
  ) {
    throw new Error('INVALID_SESSION_PHONE_REPLACEMENT');
  }
  const session = await mutableFreshSession();
  if (!session || session.ownerId !== expectedSubjectId) {
    throw new AuthenticationRequiredError();
  }
  await writeSession({ ...session, verifiedPhone });
}

export async function clearAuthenticatedServerSession(): Promise<void> {
  await clearSession();
}

export async function refreshAuthenticatedServerSession(): Promise<boolean> {
  const session = await storedSession();
  if (!session) return false;
  // This mutation endpoint is reached after an explicit Gateway/RSC refresh decision.
  // Local JWT metadata is advisory and must not override a Gateway 401.
  const refreshed = await rotate(session);
  if (refreshed) return true;
  await clearSession();
  return false;
}

export async function authenticatedGatewayFetch(
  path: `/v1/${string}`,
  init: {
    readonly handshakeTimeoutMs?: number;
    readonly headers?: HeadersInit;
    readonly signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const session = await mutableFreshSession();
  if (!session) {
    const state = await readAuthenticatedServerSessionState();
    if (state.kind === 'needs-refresh') throw new SessionRefreshRequiredError();
    throw new AuthenticationRequiredError();
  }
  const logicalHeaders = gatewayMetadataHeaders(init.headers);
  const request = async (token: string) => {
    const headers = new Headers(logicalHeaders);
    headers.delete('authorization');
    headers.set('authorization', `Bearer ${token}`);
    if (init.handshakeTimeoutMs === undefined) {
      return fetch(new URL(path, baseUrl('GATEWAY_URL')), {
        headers,
        method: 'GET',
        ...(init.signal ? { signal: init.signal } : {}),
      });
    }
    const controller = new AbortController();
    const relayAbort = () => {
      controller.abort(init.signal?.reason);
    };
    init.signal?.addEventListener('abort', relayAbort, { once: true });
    const timer = setTimeout(() => {
      controller.abort();
    }, init.handshakeTimeoutMs);
    try {
      return await fetch(new URL(path, baseUrl('GATEWAY_URL')), {
        headers,
        method: 'GET',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };
  const response = await request(session.accessToken);
  if (response.status !== 401) return response;
  await response.body?.cancel().catch(() => undefined);
  throw new SessionRefreshRequiredError();
}
