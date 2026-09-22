import { randomBytes } from 'node:crypto';

import type { AdminLoginAttemptPermit, AdminLoginThrottle } from '../ports/admin-login-throttle.js';
import { snapshotKmsIdentity, type KmsWorkloadIdentity } from './kms-secret.cipher.js';

export interface RedisCommandClient {
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
}
export interface KmsHmacClient {
  signHmac(input: {
    readonly algorithm: 'HMAC-SHA256';
    readonly keyReference: string;
    readonly data: Uint8Array;
    readonly identity: KmsWorkloadIdentity;
  }): Promise<Uint8Array>;
}
export interface LoginIdentifier {
  identify(value: string): Promise<string>;
  identifyCandidates(value: string): Promise<readonly string[]>;
}
export interface KmsHmacLoginIdentifierOptions {
  readonly keyReference?: string;
  readonly currentKeyReference?: string;
  readonly previousKeyReferences?: readonly string[];
  readonly identity: KmsWorkloadIdentity;
}

export class KmsHmacLoginIdentifier implements LoginIdentifier {
  private readonly currentKeyReference: string;
  private readonly previousKeyReferences: readonly string[];
  private readonly identity: KmsWorkloadIdentity;
  constructor(
    private readonly client: KmsHmacClient,
    options: KmsHmacLoginIdentifierOptions,
  ) {
    try {
      const legacy = Reflect.get(options, 'keyReference') as unknown;
      const current = Reflect.get(options, 'currentKeyReference') as unknown;
      const previous = Reflect.get(options, 'previousKeyReferences') as unknown;
      const identity = Reflect.get(options, 'identity') as unknown;
      const selected = current ?? legacy;
      if (typeof selected !== 'string') throw stableError('UNVERSIONED_KMS_HMAC_KEY_REFERENCE');
      this.currentKeyReference = selected;
      this.previousKeyReferences = Object.freeze(
        Array.isArray(previous) ? previous.map(String) : [],
      );
      validateVersionedKeyReference(this.currentKeyReference);
      for (const reference of this.previousKeyReferences) validateVersionedKeyReference(reference);
      if (
        new Set([this.currentKeyReference, ...this.previousKeyReferences]).size !==
        1 + this.previousKeyReferences.length
      )
        throw stableError('INVALID_KMS_HMAC_KEYRING');
      this.identity = snapshotKmsIdentity(identity);
    } catch (error) {
      if (hasCode(error)) throw error;
      throw stableError('INVALID_KMS_HMAC_CONFIGURATION');
    }
  }
  async identify(value: string): Promise<string> {
    const first = (await this.identifyCandidates(value))[0];
    if (!first) throw stableError('INVALID_LOGIN_IDENTIFIER_DIGEST');
    return first;
  }
  async identifyCandidates(value: string): Promise<readonly string[]> {
    const canonical = value.trim().toLowerCase();
    if (!canonical) throw stableError('INVALID_LOGIN_IDENTIFIER');
    const data = new TextEncoder().encode(`iam-service:admin-login-id:v1:${canonical}`);
    return Promise.all(
      [this.currentKeyReference, ...this.previousKeyReferences].map(async (keyReference) => {
        const digest = await this.client.signHmac({
          algorithm: 'HMAC-SHA256',
          keyReference,
          data: data.slice(),
          identity: this.identity,
        });
        if (digest.byteLength !== 32) throw stableError('INVALID_LOGIN_IDENTIFIER_DIGEST');
        return Buffer.from(digest).toString('hex');
      }),
    );
  }
}

export interface RedisAdminLoginThrottleOptions {
  readonly keyPrefix?: string;
  readonly maxFailures?: number;
  readonly failureWindowMs?: number;
  readonly lockDurationMs?: number;
  readonly reservationTtlMs?: number;
  readonly permitReportGraceMs?: number;
}
const RESERVE_SCRIPT = `
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local windowMs=tonumber(ARGV[1]); local maxFailures=tonumber(ARGV[2]); local ttl=tonumber(ARGV[3]); local grace=tonumber(ARGV[4]); local token=ARGV[5]
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now-grace)
local locked=tonumber(redis.call('HGET',KEYS[1],'lockedUntilMs') or '0'); if locked>now then return 0 end
local started=tonumber(redis.call('HGET',KEYS[1],'windowStartedMs') or '0'); local failures=tonumber(redis.call('HGET',KEYS[1],'failures') or '0')
if started==0 or started+windowMs<=now then redis.call('DEL',KEYS[1]); started=now; failures=0 end
if failures+redis.call('ZCOUNT',KEYS[2],'('..tostring(now),'+inf')>=maxFailures then return 0 end
if redis.call('ZADD',KEYS[2],'NX',now+ttl,token)~=1 then return -1 end
redis.call('PEXPIREAT',KEYS[2],now+ttl+grace); return 1`;
const FAILURE_SCRIPT = `
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local windowMs=tonumber(ARGV[1]); local maxFailures=tonumber(ARGV[2]); local lockMs=tonumber(ARGV[3]); local grace=tonumber(ARGV[4]); local token=ARGV[5]
local deadline=tonumber(redis.call('ZSCORE',KEYS[2],token) or '0'); if deadline==0 or deadline+grace<=now then redis.call('ZREM',KEYS[2],token); return 0 end
if redis.call('ZREM',KEYS[2],token)~=1 then return 0 end
local started=tonumber(redis.call('HGET',KEYS[1],'windowStartedMs') or '0'); local failures=tonumber(redis.call('HGET',KEYS[1],'failures') or '0')
if started==0 or started+windowMs<=now then started=now; failures=0 end
failures=failures+1; local locked=0; if failures>=maxFailures then locked=now+lockMs end
redis.call('HSET',KEYS[1],'windowStartedMs',started,'failures',failures,'lockedUntilMs',locked)
local expires=started+windowMs; if locked>expires then expires=locked end; redis.call('PEXPIREAT',KEYS[1],expires); return 1`;
const SUCCESS_SCRIPT = `local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000); local deadline=tonumber(redis.call('ZSCORE',KEYS[2],ARGV[1]) or '0'); if deadline==0 or deadline+tonumber(ARGV[2])<=now then redis.call('ZREM',KEYS[2],ARGV[1]); return 0 end; redis.call('ZREM',KEYS[2],ARGV[1]); redis.call('DEL',KEYS[1]); return 1`;
const RELEASE_SCRIPT = `local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000); local deadline=tonumber(redis.call('ZSCORE',KEYS[1],ARGV[1]) or '0'); if deadline==0 or deadline+tonumber(ARGV[2])<=now then redis.call('ZREM',KEYS[1],ARGV[1]); return 0 end; redis.call('ZREM',KEYS[1],ARGV[1]); return 1`;

export class RedisAdminLoginThrottle implements AdminLoginThrottle {
  private readonly keyPrefix: string;
  private readonly maxFailures: number;
  private readonly failureWindowMs: number;
  private readonly lockDurationMs: number;
  private readonly reservationTtlMs: number;
  private readonly permitReportGraceMs: number;
  constructor(
    private readonly redis: RedisCommandClient,
    private readonly identifier: LoginIdentifier,
    options: RedisAdminLoginThrottleOptions = {},
  ) {
    this.keyPrefix = options.keyPrefix ?? 'iam:admin-login';
    this.maxFailures = positive(options.maxFailures ?? 5);
    this.failureWindowMs = positive(options.failureWindowMs ?? 15 * 60_000);
    this.lockDurationMs = positive(options.lockDurationMs ?? 15 * 60_000);
    this.reservationTtlMs = positive(options.reservationTtlMs ?? 30_000);
    this.permitReportGraceMs = positive(options.permitReportGraceMs ?? 5 * 60_000);
    if (!this.keyPrefix || /[{}\s]/.test(this.keyPrefix))
      throw stableError('INVALID_REDIS_KEY_PREFIX');
  }
  async reserve(subject: string, now: Date): Promise<AdminLoginAttemptPermit | null> {
    void now;
    const keys = await this.keys(subject);
    const token = randomBytes(32).toString('base64url');
    const result = await this.redis.eval(
      RESERVE_SCRIPT,
      2,
      keys.budget,
      keys.reservations,
      String(this.failureWindowMs),
      String(this.maxFailures),
      String(this.reservationTtlMs),
      String(this.permitReportGraceMs),
      token,
    );
    return Number(result) === 1 ? Object.freeze({ subject, token }) : null;
  }
  async commitFailure(permit: AdminLoginAttemptPermit, now: Date): Promise<void> {
    void now;
    const keys = await this.keys(permit.subject);
    assertPermit(
      await this.redis.eval(
        FAILURE_SCRIPT,
        2,
        keys.budget,
        keys.reservations,
        String(this.failureWindowMs),
        String(this.maxFailures),
        String(this.lockDurationMs),
        String(this.permitReportGraceMs),
        permit.token,
      ),
    );
  }
  async commitSuccess(permit: AdminLoginAttemptPermit): Promise<void> {
    const keys = await this.keys(permit.subject);
    assertPermit(
      await this.redis.eval(
        SUCCESS_SCRIPT,
        2,
        keys.budget,
        keys.reservations,
        permit.token,
        String(this.permitReportGraceMs),
      ),
    );
  }
  async release(permit: AdminLoginAttemptPermit): Promise<void> {
    const keys = await this.keys(permit.subject);
    assertPermit(
      await this.redis.eval(
        RELEASE_SCRIPT,
        1,
        keys.reservations,
        permit.token,
        String(this.permitReportGraceMs),
      ),
    );
  }
  private async keys(value: string) {
    const candidates = await this.identifier.identifyCandidates(value);
    const stable = candidates.at(-1);
    if (!stable) throw stableError('INVALID_LOGIN_IDENTIFIER_DIGEST');
    return {
      budget: buildAdminLoginThrottleKey(this.keyPrefix, stable),
      reservations: buildAdminLoginReservationKey(this.keyPrefix, stable),
    };
  }
}
export function buildAdminLoginThrottleKey(prefix: string, identifier: string): string {
  validateKey(prefix, identifier);
  return `${prefix}:{${identifier}}:v2:budget`;
}
export function buildAdminLoginReservationKey(prefix: string, identifier: string): string {
  validateKey(prefix, identifier);
  return `${prefix}:{${identifier}}:v2:reservations`;
}
function validateKey(prefix: string, identifier: string) {
  if (!prefix || /[{}\s]/.test(prefix)) throw stableError('INVALID_REDIS_KEY_PREFIX');
  if (!/^[0-9a-f]{64}$/.test(identifier)) throw stableError('INVALID_LOGIN_IDENTIFIER_DIGEST');
}
function assertPermit(result: unknown) {
  if (Number(result) !== 1) throw stableError('INVALID_LOGIN_ATTEMPT_PERMIT');
}
function positive(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) throw stableError('INVALID_THROTTLE_POLICY');
  return value;
}
function validateVersionedKeyReference(reference: string) {
  if (!/^acs:kms:[^\s:]+:[^\s:]+:key\/[^\s:]+:version\/[A-Za-z0-9._-]+$/.test(reference))
    throw stableError('UNVERSIONED_KMS_HMAC_KEY_REFERENCE');
}
function hasCode(error: unknown): error is { code: string } {
  return (
    typeof error === 'object' && error !== null && typeof Reflect.get(error, 'code') === 'string'
  );
}
function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
