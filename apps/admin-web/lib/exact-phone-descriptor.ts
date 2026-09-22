import type { DataScope } from './permissions';
import { isUtcIso8601Z } from './frozen-scalars';
import { isSameUuidV7, isUuidV7 } from './uuid-v7';
import { containsSensitivePhoneLikeValue } from './sensitive-query';
import { decodeCanonicalBase64Url, encodeCanonicalBase64Url } from './canonical-base64url';

const AUDIENCE = 'admin-users-exact-phone-export';
const VERSION = 1;
const SIGNATURE_BYTES = 32;
const MAX_TTL_MS = 15 * 60_000;
const TOKEN = /^[A-Za-z0-9_-]{32,2048}$/u;
const HANDLE = /^[A-Za-z0-9_-]{16,512}$/u;

type DescriptorPayload = Readonly<{
  audience: typeof AUDIENCE;
  expiresAt: string;
  handle: string;
  sessionInstanceId: string;
  scope: DataScope;
  subjectId: string;
  version: typeof VERSION;
}>;

type SigningContext = Readonly<{ now?: () => number; signingKey: string | undefined }>;
type VerificationContext = SigningContext &
  Readonly<{ scope: DataScope; sessionInstanceId: string; subjectId: string }>;

export function isValidExactPhoneDescriptorSigningKey(value: unknown): value is string {
  return typeof value === 'string' && new TextEncoder().encode(value).byteLength >= 32;
}

async function importKey(signingKey: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(signingKey),
    { hash: 'SHA-256', name: 'HMAC' },
    false,
    ['sign', 'verify'],
  );
}

function bytesToBase64Url(bytes: Uint8Array): string {
  return encodeCanonicalBase64Url(bytes);
}

export function isValidExactPhoneUpstreamExpiry(value: unknown, now = Date.now()): value is string {
  if (!isUtcIso8601Z(value)) return false;
  const expiresAt = Date.parse(value);
  return expiresAt > now && expiresAt <= now + MAX_TTL_MS;
}

function invalid(): never {
  throw new Error('搜索凭证无效');
}

export function isValidExactPhoneUpstreamHandle(value: unknown): value is string {
  return typeof value === 'string' && HANDLE.test(value) && !containsSensitivePhoneLikeValue(value);
}

export async function sealExactPhoneSearchDescriptor(
  input: Readonly<{
    expiresAt: string;
    handle: string;
    scope: DataScope;
    sessionInstanceId: string;
    subjectId: string;
  }>,
  { now = Date.now, signingKey }: SigningContext,
): Promise<string> {
  if (!isValidExactPhoneDescriptorSigningKey(signingKey)) throw new Error('搜索凭证签名配置无效');
  if (
    !isValidExactPhoneUpstreamHandle(input.handle) ||
    !isValidExactPhoneUpstreamExpiry(input.expiresAt, now()) ||
    !isUuidV7(input.subjectId) ||
    !isUuidV7(input.sessionInstanceId)
  )
    invalid();
  const payload: DescriptorPayload = {
    audience: AUDIENCE,
    expiresAt: input.expiresAt,
    handle: input.handle,
    sessionInstanceId: input.sessionInstanceId,
    scope: input.scope,
    subjectId: input.subjectId,
    version: VERSION,
  };
  const encodedPayload = new TextEncoder().encode(JSON.stringify(payload));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await importKey(signingKey), encodedPayload),
  );
  const envelope = new Uint8Array(encodedPayload.length + signature.length);
  envelope.set(encodedPayload);
  envelope.set(signature, encodedPayload.length);
  const token = bytesToBase64Url(envelope);
  if (!TOKEN.test(token) || containsSensitivePhoneLikeValue(token)) invalid();
  return token;
}

export async function verifyExactPhoneSearchDescriptor(
  token: unknown,
  { now = Date.now, scope, sessionInstanceId, signingKey, subjectId }: VerificationContext,
): Promise<Readonly<{ expiresAt: string; handle: string }>> {
  if (!isValidExactPhoneDescriptorSigningKey(signingKey)) throw new Error('搜索凭证签名配置无效');
  if (
    typeof token !== 'string' ||
    !TOKEN.test(token) ||
    containsSensitivePhoneLikeValue(token) ||
    !isUuidV7(subjectId) ||
    !isUuidV7(sessionInstanceId)
  )
    invalid();
  try {
    const envelope = decodeCanonicalBase64Url(token, { maximumLength: 2048, minimumLength: 32 });
    if (!envelope) invalid();
    if (envelope.length <= SIGNATURE_BYTES) invalid();
    const payloadBytes = envelope.slice(0, -SIGNATURE_BYTES);
    const signature = envelope.slice(-SIGNATURE_BYTES);
    if (!(await crypto.subtle.verify('HMAC', await importKey(signingKey), signature, payloadBytes)))
      invalid();
    const payload = JSON.parse(
      new TextDecoder().decode(payloadBytes),
    ) as Partial<DescriptorPayload>;
    if (
      payload.version !== VERSION ||
      payload.audience !== AUDIENCE ||
      payload.scope !== scope ||
      !isSameUuidV7(payload.sessionInstanceId, sessionInstanceId) ||
      !isSameUuidV7(payload.subjectId, subjectId) ||
      !isValidExactPhoneUpstreamHandle(payload.handle) ||
      !isValidExactPhoneUpstreamExpiry(payload.expiresAt, now())
    )
      invalid();
    return { expiresAt: payload.expiresAt, handle: payload.handle };
  } catch (error) {
    if (
      error instanceof Error &&
      (error.message === '搜索凭证无效' || error.message === '搜索凭证签名配置无效')
    )
      throw error;
    return invalid();
  }
}
