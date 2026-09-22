import { isValidAdminPermissions, type AdminSubject } from './permissions';
import { normalizeAdminLoginReturnTarget } from './admin-return-target';
import { isUuidV7 } from './uuid-v7';
import { decodeCanonicalBase64Url, encodeCanonicalBase64Url } from './canonical-base64url';

export const ADMIN_SESSION_COOKIE = '__Host-admin_session';
export const ADMIN_MFA_CHALLENGE_COOKIE = '__Host-admin_mfa';
export const ADMIN_MFA_CHALLENGE_TTL_SECONDS = 10 * 60;
export const ADMIN_MFA_CHALLENGE_TTL_MS = ADMIN_MFA_CHALLENGE_TTL_SECONDS * 1000;
export const ADMIN_MFA_CHALLENGE_ID_LENGTH = 43;
export const ADMIN_MFA_AUDIENCE = 'admin-mfa';
export const ADMIN_MFA_VERSION = 1;
export const ADMIN_AUTH_TOKEN_MAX_LENGTH = 3000;

export type AdminSessionClaims = AdminSubject &
  Readonly<{
    subjectId: string;
    sessionInstanceId: string;
    expiresAt: number;
  }>;

type AdminMfaChallengeBaseClaims = Readonly<{
  audience: typeof ADMIN_MFA_AUDIENCE;
  correlationId: string;
  expiresAt: number;
  identifierBinding: string;
  redirectTo?: string;
  seed: string;
  version: typeof ADMIN_MFA_VERSION;
}>;

export type AdminMfaChallengeClaims =
  | (AdminMfaChallengeBaseClaims & Readonly<{ stage: 'PASSWORD' }>)
  | (AdminMfaChallengeBaseClaims & Readonly<{ challengeId: string; stage: 'TOTP' }>);

export type AuthorizationErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN';

export class AuthorizationError extends Error {
  readonly code: AuthorizationErrorCode;

  constructor(code: AuthorizationErrorCode, message: string) {
    super(message);
    this.name = 'AuthorizationError';
    this.code = code;
  }
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return encodeCanonicalBase64Url(bytes);
}

export function createRandomAdminMfaChallengeId(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export function isValidAdminMfaChallengeId(value: unknown): value is string {
  const bytes = decodeCanonicalBase64Url(value, {
    maximumLength: ADMIN_MFA_CHALLENGE_ID_LENGTH,
    minimumLength: ADMIN_MFA_CHALLENGE_ID_LENGTH,
  });
  return bytes?.length === 32;
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

export function isValidAdminSigningKey(signingKey: string | undefined): signingKey is string {
  return typeof signingKey === 'string' && new TextEncoder().encode(signingKey).byteLength >= 32;
}

async function importSigningKey(signingKey: string): Promise<CryptoKey> {
  if (!isValidAdminSigningKey(signingKey)) {
    throw new Error('Admin signing key must be at least 32 bytes');
  }

  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign', 'verify'],
  );
}

function isAdminSessionClaims(value: unknown): value is AdminSessionClaims {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }

  const candidate = value as Partial<AdminSessionClaims>;
  return (
    Object.keys(value).sort().join(',') ===
      'dataScope,expiresAt,permissions,sessionInstanceId,subjectId' &&
    isUuidV7(candidate.subjectId) &&
    isUuidV7(candidate.sessionInstanceId) &&
    isValidAdminPermissions(candidate.permissions) &&
    (candidate.dataScope === 'ALL' ||
      candidate.dataScope === 'OWN' ||
      candidate.dataScope === 'ASSIGNED') &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt)
  );
}

function isAdminMfaChallengeClaims(value: unknown): value is AdminMfaChallengeClaims {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return false;
  }

  const candidate = value as Partial<AdminMfaChallengeClaims>;
  const baseKeys = [
    'audience',
    'correlationId',
    'expiresAt',
    'identifierBinding',
    'seed',
    'stage',
    'version',
  ];
  const redirectKey = candidate.redirectTo === undefined ? [] : ['redirectTo'];
  const exactKeys =
    candidate.stage === 'PASSWORD'
      ? [...baseKeys, ...redirectKey].sort().join(',')
      : candidate.stage === 'TOTP'
        ? [...baseKeys, 'challengeId', ...redirectKey].sort().join(',')
        : '';
  return (
    Object.keys(value).sort().join(',') === exactKeys &&
    candidate.audience === ADMIN_MFA_AUDIENCE &&
    isUuidV7(candidate.correlationId) &&
    isValidAdminMfaChallengeId(candidate.identifierBinding) &&
    isValidAdminMfaChallengeId(candidate.seed) &&
    (candidate.redirectTo === undefined ||
      normalizeAdminLoginReturnTarget(candidate.redirectTo) === candidate.redirectTo) &&
    (candidate.stage === 'PASSWORD' ||
      (candidate.stage === 'TOTP' && isValidAdminMfaChallengeId(candidate.challengeId))) &&
    candidate.version === ADMIN_MFA_VERSION &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt)
  );
}

async function hmacBytes(value: string, signingKey: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      await importSigningKey(signingKey),
      new TextEncoder().encode(value),
    ),
  );
}

export async function createAdminMfaIdentifierBinding(
  identifier: string,
  signingKey: string,
): Promise<string> {
  return bytesToBase64Url(await hmacBytes(`admin-mfa:identifier:${identifier}`, signingKey));
}

export async function deriveAdminMfaIdempotencyKey(
  seed: string,
  attempt: string,
  signingKey: string,
): Promise<string> {
  if (!isValidAdminMfaChallengeId(seed)) throw new Error('Invalid admin MFA seed');
  const bytes = (await hmacBytes(`admin-mfa:command:${seed}:${attempt}`, signingKey)).slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function signClaims(value: unknown, signingKey: string): Promise<string> {
  const payload = textToBase64Url(JSON.stringify(value));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importSigningKey(signingKey),
    new TextEncoder().encode(payload),
  );

  const token = `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
  if (token.length > ADMIN_AUTH_TOKEN_MAX_LENGTH)
    throw new Error('Admin auth token exceeds safe cookie bound');
  return token;
}

async function verifyClaims(
  token: string | undefined,
  signingKey: string | undefined,
): Promise<unknown> {
  if (!token || !signingKey) {
    return null;
  }
  if (token.length > ADMIN_AUTH_TOKEN_MAX_LENGTH) return null;

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [payload, encodedSignature] = parts;
  if (!payload || !encodedSignature) {
    return null;
  }

  const payloadBytes = decodeCanonicalBase64Url(payload, {
    maximumLength: ADMIN_AUTH_TOKEN_MAX_LENGTH,
  });
  const signatureBytes = decodeCanonicalBase64Url(encodedSignature, { maximumLength: 128 });
  if (!payloadBytes || !signatureBytes) return null;
  try {
    const signatureIsValid = await crypto.subtle.verify(
      'HMAC',
      await importSigningKey(signingKey),
      signatureBytes,
      new TextEncoder().encode(payload),
    );
    if (!signatureIsValid) {
      return null;
    }

    return JSON.parse(new TextDecoder().decode(payloadBytes)) as unknown;
  } catch {
    return null;
  }
}

export async function signAdminSession(
  claims: AdminSessionClaims,
  signingKey: string,
): Promise<string> {
  if (!isAdminSessionClaims(claims)) {
    throw new Error('Invalid admin session claims');
  }
  return signClaims(claims, signingKey);
}

export async function verifyAdminSession(
  token: string | undefined,
  signingKey: string | undefined,
  now = Date.now(),
): Promise<AdminSessionClaims | null> {
  const claims = await verifyClaims(token, signingKey);
  if (!isAdminSessionClaims(claims) || claims.expiresAt <= now) {
    return null;
  }

  return claims;
}

export async function signAdminMfaChallenge(
  claims: AdminMfaChallengeClaims,
  signingKey: string,
): Promise<string> {
  if (!isAdminMfaChallengeClaims(claims)) throw new Error('Invalid admin MFA claims');
  return signClaims(claims, signingKey);
}

export async function verifyAdminMfaChallenge(
  token: string | undefined,
  signingKey: string | undefined,
  now = Date.now(),
): Promise<AdminMfaChallengeClaims | null> {
  const claims = await verifyClaims(token, signingKey);
  if (
    !isAdminMfaChallengeClaims(claims) ||
    claims.expiresAt <= now ||
    claims.expiresAt > now + ADMIN_MFA_CHALLENGE_TTL_MS
  ) {
    return null;
  }

  return claims;
}
