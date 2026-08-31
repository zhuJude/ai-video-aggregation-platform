/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access -- narrow Prisma structural boundary. */
import type { ProviderCallbackAuthenticator, ProviderTaskAuthorization, RawHttpHeaders, UserAuthenticator } from './asset-http.module.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_CALLBACK_MAX_AGE_MS = 5 * 60 * 1_000;
const MAX_CALLBACK_FUTURE_SKEW_MS = 30_000;

export interface IdentityTokenVerifier {
  /** Production implementation verifies signature, issuer, audience and expiry through trusted JWKS. */
  verifyBearerToken(token: string): Promise<{ subject: string } | null>;
}

export class JwksUserAuthenticator implements UserAuthenticator {
  constructor(private readonly verifier: IdentityTokenVerifier) {}

  async authenticate(headers: RawHttpHeaders): Promise<{ userId: string } | null> {
    const authorization = singleHeader(headers.authorization);
    if (authorization === undefined || !authorization.startsWith('Bearer ')) return null;
    const token = authorization.slice('Bearer '.length);
    if (token.length === 0 || token.length > 8192) return null;
    const identity = await this.verifier.verifyBearerToken(token);
    return identity !== null && UUID_PATTERN.test(identity.subject) ? { userId: identity.subject } : null;
  }
}

export interface KmsMacVerifier {
  verifyMac(input: {
    kmsKeyReference: string;
    algorithm: 'HMAC_SHA_256';
    message: Uint8Array;
    mac: string;
  }): Promise<boolean>;
}

export interface ProviderNonceStore {
  /** Atomic insert-if-absent; false means this signed nonce was already consumed. */
  claim(input: { providerId: string; nonce: string; expiresAt: Date }): Promise<boolean>;
  deleteExpired?(now: Date, limit?: number): Promise<number>;
}

export class PrismaProviderNonceStore implements ProviderNonceStore {
  constructor(private readonly client: { $transaction<T>(work: (tx: any) => Promise<T>): Promise<T> }) {}

  async claim(input: { providerId: string; nonce: string; expiresAt: Date }): Promise<boolean> {
    return this.client.$transaction(async (tx) => (await tx.providerCallbackNonce.createMany({
      data: [input],
      skipDuplicates: true,
    })).count === 1);
  }

  async deleteExpired(now: Date, limit = 500): Promise<number> {
    return this.client.$transaction(async (tx) => {
      const rows = await tx.providerCallbackNonce.findMany({ where: { expiresAt: { lte: now } }, select: { providerId: true, nonce: true }, take: limit });
      if (rows.length === 0) return 0;
      const deleted = await tx.providerCallbackNonce.deleteMany({ where: { OR: rows.map((row: { providerId: string; nonce: string }) => ({ providerId: row.providerId, nonce: row.nonce })) } });
      return deleted.count as number;
    });
  }
}

export class ProviderNonceCleanupJob {
  constructor(private readonly store: Pick<PrismaProviderNonceStore, 'deleteExpired'>, private readonly now: () => Date = () => new Date()) {}
  run(): Promise<number> { return this.store.deleteExpired(this.now()); }
}

export class KmsProviderCallbackAuthenticator implements ProviderCallbackAuthenticator {
  readonly #providers: Readonly<Record<string, { kmsKeyReference: string }>>;
  readonly #macVerifier: KmsMacVerifier;
  readonly #nonceStore: ProviderNonceStore;
  readonly #now: () => Date;
  readonly #maxAgeMs: number;

  constructor(input: {
    providers: Readonly<Record<string, { kmsKeyReference: string }>>;
    macVerifier: KmsMacVerifier;
    nonceStore: ProviderNonceStore;
    now?: () => Date;
    maxAgeMs?: number;
  }) {
    for (const provider of Object.values(input.providers)) {
      if (!isKmsReference(provider.kmsKeyReference)) throw new Error('Provider callback key must be a KMS reference');
    }
    this.#providers = input.providers;
    this.#macVerifier = input.macVerifier;
    this.#nonceStore = input.nonceStore;
    this.#now = input.now ?? (() => new Date());
    this.#maxAgeMs = input.maxAgeMs ?? DEFAULT_CALLBACK_MAX_AGE_MS;
  }

  async authenticate(request: { headers: RawHttpHeaders; rawBody: Uint8Array }): Promise<{ providerId: string } | null> {
    const providerId = singleHeader(request.headers['x-provider-id']);
    const timestamp = singleHeader(request.headers['x-provider-timestamp']);
    const nonce = singleHeader(request.headers['x-provider-nonce']);
    const mac = singleHeader(request.headers['x-provider-signature']);
    if (providerId === undefined || timestamp === undefined || nonce === undefined || mac === undefined) return null;
    const provider = this.#providers[providerId];
    if (provider === undefined || nonce.length < 8 || nonce.length > 128 || mac.length === 0 || mac.length > 4096) return null;
    const signedAtMs = Date.parse(timestamp);
    const nowMs = this.#now().getTime();
    if (!Number.isFinite(signedAtMs) || signedAtMs < nowMs - this.#maxAgeMs || signedAtMs > nowMs + MAX_CALLBACK_FUTURE_SKEW_MS) return null;
    const prefix = Buffer.from(`${providerId}\n${timestamp}\n${nonce}\n`, 'utf8');
    const message = Buffer.concat([prefix, Buffer.from(request.rawBody)]);
    const valid = await this.#macVerifier.verifyMac({ kmsKeyReference: provider.kmsKeyReference, algorithm: 'HMAC_SHA_256', message, mac });
    if (!valid) return null;
    const claimed = await this.#nonceStore.claim({ providerId, nonce, expiresAt: new Date(signedAtMs + this.#maxAgeMs) });
    return claimed ? { providerId } : null;
  }
}

/** Server-owned authorization records prevent callbacks from supplying owner or integrity metadata. */
export class PrismaProviderTaskAuthorization implements ProviderTaskAuthorization {
  constructor(
    private readonly client: { $transaction<T>(work: (tx: any) => Promise<T>): Promise<T> },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authorize(providerId: string, providerTaskId: string) {
    return this.client.$transaction(async (tx) => {
      const row = await tx.providerResultAuthorization.findFirst({
        where: { providerId, providerTaskId, status: 'AWAITING_RESULT', expiresAt: { gt: this.now() } },
      });
      if (row === null || !Array.isArray(row.allowedHosts) || row.allowedHosts.length === 0 || row.allowedHosts.some((host: unknown) => typeof host !== 'string' || host.length === 0)) return null;
      return {
        authorizationId: row.id as string,
        ownerId: row.ownerId as string,
        providerTaskId: row.providerTaskId as string,
        allowedHosts: row.allowedHosts as string[],
        expectedMimeType: row.expectedMimeType as string,
        expectedSizeBytes: row.expectedSizeBytes as bigint,
        ...(row.expectedChecksum === null ? {} : { expectedChecksum: row.expectedChecksum as string }),
        originalFileName: row.originalFileName as string,
      };
    });
  }
}

function singleHeader(value: string | string[] | undefined): string | undefined { return Array.isArray(value) ? value[0] : value; }
function isKmsReference(reference: string): boolean {
  return /^kms:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(reference) || /^acs:kms:[a-z0-9-]+:\d+:(?:key|alias)\/[A-Za-z0-9._-]+$/i.test(reference);
}
