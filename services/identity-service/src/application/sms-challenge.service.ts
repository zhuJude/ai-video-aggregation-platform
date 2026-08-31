import { randomInt } from 'node:crypto';

import { SmsRequestContext } from '../domain/sms-request-context.js';
import { smsRateKey } from '../domain/sms-security-key.js';
import type { ChallengeCodeHasher } from '../ports/challenge-secret.js';
import type { ChallengeStore, RateLimitRule } from '../ports/challenge-store.js';
import type { PrivacyIdentifierHasher } from '../ports/privacy-identifier.js';
import type { SmsSender } from '../ports/sms-sender.js';

const INVALID_PHONE = 'INVALID_PHONE';
const INVALID_SMS_CODE = 'INVALID_SMS_CODE';
const SMS_CHALLENGE_LOCKED = 'SMS_CHALLENGE_LOCKED';
const SMS_RATE_LIMITED = 'SMS_RATE_LIMITED';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;

export interface SmsRateLimitPolicy {
  readonly cooldownMs: number;
  readonly windowMs: number;
  readonly phoneLimit: number;
  readonly ipLimit: number;
  readonly deviceLimit: number;
}

export const DEFAULT_SMS_RATE_LIMIT_POLICY: SmsRateLimitPolicy = {
  cooldownMs: 60 * 1000,
  windowMs: 60 * 60 * 1000,
  phoneLimit: 5,
  ipLimit: 30,
  deviceLimit: 10,
};

export interface SmsChallengeServiceDependencies {
  store: ChallengeStore;
  sender: SmsSender;
  hasher: ChallengeCodeHasher;
  privacyIdentifierHasher: PrivacyIdentifierHasher;
  now?: () => number;
  generateCode?: () => string;
  rateLimitPolicy?: SmsRateLimitPolicy;
}

export interface IssueSmsChallengeInput {
  phoneE164: string;
  context: SmsRequestContext;
}

export interface VerifySmsChallengeInput {
  phoneE164: string;
  code: string;
}

export class SmsChallengeService {
  private readonly now: () => number;
  private readonly generateCode: () => string;
  private readonly policy: SmsRateLimitPolicy;

  constructor(private readonly dependencies: SmsChallengeServiceDependencies) {
    this.now = dependencies.now ?? Date.now;
    this.generateCode =
      dependencies.generateCode ?? (() => randomInt(0, 1_000_000).toString().padStart(6, '0'));
    this.policy = Object.freeze({
      ...(dependencies.rateLimitPolicy ?? DEFAULT_SMS_RATE_LIMIT_POLICY),
    });
    validatePolicy(this.policy);
  }

  async issue(input: IssueSmsChallengeInput): Promise<void> {
    validatePhone(input.phoneE164);
    SmsRequestContext.assertTrusted(input.context);

    const code = this.generateCode();
    validateCode(code);
    const issuedAtMs = this.now();
    const [phoneHash, ipHash, deviceHash] = await Promise.all([
      this.dependencies.privacyIdentifierHasher.hash('redis-phone', input.phoneE164),
      this.dependencies.privacyIdentifierHasher.hash('redis-ip', input.context.canonicalIp),
      this.dependencies.privacyIdentifierHasher.hash(
        'redis-device',
        input.context.canonicalDeviceId,
      ),
    ]);
    const codeDigest = await this.dependencies.hasher.hash(phoneHash, code);
    const expiresAtMs = issuedAtMs + CHALLENGE_TTL_MS;
    const nowMs = this.now();
    if (nowMs >= expiresAtMs) throw stableError('SMS_CHALLENGE_EXPIRED');
    const result = await this.dependencies.store.issue({
      phoneHash,
      nowMs,
      record: {
        codeDigest,
        issuedAtMs,
        expiresAtMs,
        failedAttempts: 0,
      },
      rateLimits: buildRateLimits(phoneHash, ipHash, deviceHash, this.policy),
    });

    if (result === 'rate_limited') throw stableError(SMS_RATE_LIMITED);

    try {
      await this.dependencies.sender.sendCode(input.phoneE164, code);
    } catch (error: unknown) {
      await this.dependencies.store.remove({ phoneHash, codeDigest, issuedAtMs });
      throw error;
    }
  }

  async verify(input: VerifySmsChallengeInput): Promise<boolean> {
    validatePhone(input.phoneE164);
    validateCode(input.code);
    const phoneHash = await this.dependencies.privacyIdentifierHasher.hash(
      'redis-phone',
      input.phoneE164,
    );
    const result = await this.dependencies.store.verify({
      phoneHash,
      codeDigest: await this.dependencies.hasher.hash(phoneHash, input.code),
      nowMs: this.now(),
      maxAttempts: MAX_ATTEMPTS,
    });

    if (result === 'locked') throw stableError(SMS_CHALLENGE_LOCKED);
    return result === 'verified';
  }
}

function buildRateLimits(
  phoneHash: string,
  ipHash: string,
  deviceHash: string,
  policy: SmsRateLimitPolicy,
): RateLimitRule[] {
  const rules: RateLimitRule[] = [];
  if (policy.cooldownMs > 0) {
    rules.push({
      key: smsRateKey('cooldown', phoneHash),
      limit: 1,
      windowMs: policy.cooldownMs,
    });
  }
  rules.push(
    {
      key: smsRateKey('phone', phoneHash),
      limit: policy.phoneLimit,
      windowMs: policy.windowMs,
    },
    {
      key: smsRateKey('ip', ipHash),
      limit: policy.ipLimit,
      windowMs: policy.windowMs,
    },
    {
      key: smsRateKey('device', deviceHash),
      limit: policy.deviceLimit,
      windowMs: policy.windowMs,
    },
  );
  return rules;
}

function validatePhone(phoneE164: string): void {
  if (!/^\+861[3-9]\d{9}$/.test(phoneE164)) throw stableError(INVALID_PHONE);
}

function validateCode(code: string): void {
  if (!/^\d{6}$/.test(code)) throw stableError(INVALID_SMS_CODE);
}

function validatePolicy(policy: SmsRateLimitPolicy): void {
  const positiveValues = [policy.windowMs, policy.phoneLimit, policy.ipLimit, policy.deviceLimit];
  if (
    !Number.isSafeInteger(policy.cooldownMs) ||
    policy.cooldownMs < 0 ||
    positiveValues.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error('INVALID_SMS_RATE_LIMIT_POLICY');
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
