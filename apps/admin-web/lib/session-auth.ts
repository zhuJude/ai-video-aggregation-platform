import type { AdminSubject } from './permissions';

export const ADMIN_SESSION_COOKIE = '__Host-admin_session';
export const ADMIN_MFA_CHALLENGE_COOKIE = '__Host-admin_mfa';
export const ADMIN_MFA_CHALLENGE_TTL_SECONDS = 10 * 60;
export const ADMIN_MFA_CHALLENGE_TTL_MS =
  ADMIN_MFA_CHALLENGE_TTL_SECONDS * 1000;
export const ADMIN_MFA_CHALLENGE_ID_LENGTH = 43;

export type AdminSessionClaims = AdminSubject &
  Readonly<{
    subjectId: string;
    expiresAt: number;
  }>;

export type AdminMfaChallengeClaims = Readonly<{
  challengeId: string;
  expiresAt: number;
}>;

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
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

export function createRandomAdminMfaChallengeId(): string {
  return bytesToBase64Url(
    crypto.getRandomValues(new Uint8Array(32)),
  );
}

export function isValidAdminMfaChallengeId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === ADMIN_MFA_CHALLENGE_ID_LENGTH &&
    /^[A-Za-z0-9_-]+$/.test(value)
  );
}

function textToBase64Url(value: string): string {
  return bytesToBase64Url(new TextEncoder().encode(value));
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replaceAll('-', '+').replaceAll('_', '/').padEnd(
    Math.ceil(value.length / 4) * 4,
    '=',
  );
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function isValidAdminSigningKey(
  signingKey: string | undefined,
): signingKey is string {
  return (
    typeof signingKey === 'string' &&
    new TextEncoder().encode(signingKey).byteLength >= 32
  );
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
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AdminSessionClaims>;
  return (
    typeof candidate.subjectId === 'string' &&
    candidate.subjectId.length > 0 &&
    Array.isArray(candidate.permissions) &&
    candidate.permissions.every((permission) => typeof permission === 'string') &&
    (candidate.dataScope === 'ALL' ||
      candidate.dataScope === 'OWN' ||
      candidate.dataScope === 'ASSIGNED') &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt)
  );
}

function isAdminMfaChallengeClaims(
  value: unknown,
): value is AdminMfaChallengeClaims {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<AdminMfaChallengeClaims>;
  return (
    isValidAdminMfaChallengeId(candidate.challengeId) &&
    typeof candidate.expiresAt === 'number' &&
    Number.isFinite(candidate.expiresAt)
  );
}

async function signClaims(value: unknown, signingKey: string): Promise<string> {
  const payload = textToBase64Url(JSON.stringify(value));
  const signature = await crypto.subtle.sign(
    'HMAC',
    await importSigningKey(signingKey),
    new TextEncoder().encode(payload),
  );

  return `${payload}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

async function verifyClaims(
  token: string | undefined,
  signingKey: string | undefined,
): Promise<unknown> {
  if (!token || !signingKey) {
    return null;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    return null;
  }

  const [payload, encodedSignature] = parts;
  if (!payload || !encodedSignature) {
    return null;
  }

  try {
    const signatureIsValid = await crypto.subtle.verify(
      'HMAC',
      await importSigningKey(signingKey),
      base64UrlToBytes(encodedSignature),
      new TextEncoder().encode(payload),
    );
    if (!signatureIsValid) {
      return null;
    }

    return JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(payload)),
    ) as unknown;
  } catch {
    return null;
  }
}

export async function signAdminSession(
  claims: AdminSessionClaims,
  signingKey: string,
): Promise<string> {
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
  return signClaims(claims, signingKey);
}

export async function verifyAdminMfaChallenge(
  token: string | undefined,
  signingKey: string | undefined,
  now = Date.now(),
): Promise<AdminMfaChallengeClaims | null> {
  const claims = await verifyClaims(token, signingKey);
  if (!isAdminMfaChallengeClaims(claims) || claims.expiresAt <= now) {
    return null;
  }

  return claims;
}
