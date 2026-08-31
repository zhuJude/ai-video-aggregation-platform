import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { HmacChallengeCodeHasher } from '../src/adapters/hmac-challenge-code.hasher.js';
import { HmacPrivacyIdentifierHasher } from '../src/adapters/hmac-privacy-identifier.hasher.js';
import { SmsChallengeService } from '../src/application/sms-challenge.service.js';
import { SmsRequestContext } from '../src/domain/sms-request-context.js';
import type {
  ChallengeIssue,
  ChallengeIssueResult,
  ChallengeRecord,
  ChallengeRemoval,
  ChallengeStore,
  ChallengeVerification,
  ChallengeVerificationResult,
  RateLimitRule,
} from '../src/ports/challenge-store.js';
import type { SmsSender } from '../src/ports/sms-sender.js';

class MemoryChallengeStore implements ChallengeStore {
  readonly challenges = new Map<string, ChallengeRecord>();
  readonly issueKeys: string[][] = [];
  private readonly rateWindows = new Map<string, { count: number; expiresAtMs: number }>();

  issue(input: ChallengeIssue): Promise<ChallengeIssueResult> {
    this.issueKeys.push(input.rateLimits.map((limit) => limit.key));

    for (const rule of input.rateLimits) {
      const window = this.activeWindow(rule, input.nowMs);
      if (window.count >= rule.limit) return Promise.resolve('rate_limited');
    }

    for (const rule of input.rateLimits) {
      const window = this.activeWindow(rule, input.nowMs);
      this.rateWindows.set(rule.key, {
        count: window.count + 1,
        expiresAtMs: window.expiresAtMs,
      });
    }

    this.challenges.set(input.phoneHash, structuredClone(input.record));
    return Promise.resolve('issued');
  }

  verify(input: ChallengeVerification): Promise<ChallengeVerificationResult> {
    const record = this.challenges.get(input.phoneHash);
    if (!record) return Promise.resolve('missing');
    if (record.expiresAtMs <= input.nowMs) {
      this.challenges.delete(input.phoneHash);
      return Promise.resolve('expired');
    }
    if (record.failedAttempts >= input.maxAttempts) return Promise.resolve('locked');
    if (record.codeDigest === input.codeDigest) {
      this.challenges.delete(input.phoneHash);
      return Promise.resolve('verified');
    }

    record.failedAttempts += 1;
    return Promise.resolve('invalid');
  }

  remove(input: ChallengeRemoval): Promise<void> {
    const record = this.challenges.get(input.phoneHash);
    if (record?.codeDigest === input.codeDigest && record.issuedAtMs === input.issuedAtMs) {
      this.challenges.delete(input.phoneHash);
    }
    return Promise.resolve();
  }

  private activeWindow(rule: RateLimitRule, nowMs: number): { count: number; expiresAtMs: number } {
    const current = this.rateWindows.get(rule.key);
    return current && current.expiresAtMs > nowMs
      ? current
      : { count: 0, expiresAtMs: nowMs + rule.windowMs };
  }
}

class CapturingSmsSender implements SmsSender {
  readonly sent: Array<{ phoneE164: string; code: string }> = [];

  sendCode(phoneE164: string, code: string): Promise<void> {
    this.sent.push({ phoneE164, code });
    return Promise.resolve();
  }
}

function makeVoidDeferred() {
  let resolvePromise: (() => void) | undefined;
  let rejectPromise: ((reason?: unknown) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    promise,
    resolve: () => {
      if (!resolvePromise) throw new Error('DEFERRED_NOT_INITIALIZED');
      resolvePromise();
    },
    reject: (reason?: unknown) => {
      if (!rejectPromise) throw new Error('DEFERRED_NOT_INITIALIZED');
      rejectPromise(reason);
    },
  };
}

const phone = '+8613800138000';

function makeFixture(
  overrides: Partial<ConstructorParameters<typeof SmsChallengeService>[0]> = {},
  options: { codeHashDelayMs?: number } = {},
) {
  let nowMs = Date.UTC(2026, 7, 31, 0, 0, 0);
  const store = new MemoryChallengeStore();
  const sender = new CapturingSmsSender();
  const hasher = new HmacChallengeCodeHasher(
    {
      getSecret: (kmsKeyReference) => {
        expect(kmsKeyReference).toBe('kms://identity/test-sms-pepper#version=1');
        nowMs += options.codeHashDelayMs ?? 0;
        return Promise.resolve(Buffer.from('test-only-fixed-pepper-32-bytes!!'));
      },
    },
    'kms://identity/test-sms-pepper#version=1',
  );
  const privacyIdentifierHasher = new HmacPrivacyIdentifierHasher(
    { getPrivacyIdentifierSecret: () => Promise.resolve(Buffer.alloc(32, 11)) },
    'kms://identity/test-privacy-identifiers#version=1',
  );
  const service = new SmsChallengeService({
    store,
    sender,
    hasher,
    privacyIdentifierHasher,
    now: () => nowMs,
    generateCode: () => '123456',
    ...overrides,
  });

  return {
    service,
    sender,
    store,
    advanceBy: (milliseconds: number) => {
      nowMs += milliseconds;
    },
  };
}

function trustedContext(ipAddress = '203.0.113.8', deviceId = 'device-a'): SmsRequestContext {
  return SmsRequestContext.fromDirectSocket({
    ipAddress,
    deviceId,
  });
}

describe('SmsChallengeService', () => {
  it('accepts an issued six-digit code once and rejects replay', async () => {
    const { sender, service } = makeFixture();

    await service.issue({ phoneE164: phone, context: trustedContext() });

    expect(sender.sent).toEqual([{ phoneE164: phone, code: '123456' }]);
    await expect(service.verify({ phoneE164: phone, code: '123456' })).resolves.toBe(true);
    await expect(service.verify({ phoneE164: phone, code: '123456' })).resolves.toBe(false);
  });

  it('stores only a keyed digest and never the plaintext code', async () => {
    const { service, store } = makeFixture();

    await service.issue({ phoneE164: phone, context: trustedContext() });

    const record = [...store.challenges.values()][0];
    expect(record).toBeDefined();
    expect(JSON.stringify(record)).not.toContain('123456');
    expect(record?.codeDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects and removes a challenge at the five-minute expiry boundary', async () => {
    const { advanceBy, service, store } = makeFixture();
    await service.issue({ phoneE164: phone, context: trustedContext() });
    advanceBy(5 * 60 * 1000);

    await expect(service.verify({ phoneE164: phone, code: '123456' })).resolves.toBe(false);
    expect(store.challenges.size).toBe(0);
  });

  it('returns false for five wrong attempts and locks the sixth wrong attempt', async () => {
    const { service } = makeFixture();
    await service.issue({ phoneE164: phone, context: trustedContext() });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(service.verify({ phoneE164: phone, code: '000000' })).resolves.toBe(false);
    }
    await expect(service.verify({ phoneE164: phone, code: '000000' })).rejects.toMatchObject({
      code: 'SMS_CHALLENGE_LOCKED',
    });
  });

  it('rejects the correct code as locked after five wrong attempts', async () => {
    const { service } = makeFixture();
    await service.issue({ phoneE164: phone, context: trustedContext() });

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await expect(service.verify({ phoneE164: phone, code: '000000' })).resolves.toBe(false);
    }
    await expect(service.verify({ phoneE164: phone, code: '123456' })).rejects.toMatchObject({
      code: 'SMS_CHALLENGE_LOCKED',
    });
  });

  it('rate limits a reissue during the 60-second cooldown', async () => {
    const { advanceBy, service } = makeFixture();
    const input = { phoneE164: phone, context: trustedContext() };
    await service.issue(input);

    await expect(service.issue(input)).rejects.toMatchObject({ code: 'SMS_RATE_LIMITED' });
    advanceBy(60_000);
    await expect(service.issue(input)).resolves.toBeUndefined();
  });

  it('does not let a delayed send failure remove a newer challenge', async () => {
    const firstSendStarted = makeVoidDeferred();
    const firstSend = makeVoidDeferred();
    let sendCount = 0;
    const codes = ['123456', '654321'];
    const fixture = makeFixture({
      sender: {
        sendCode: () => {
          sendCount += 1;
          if (sendCount === 1) {
            firstSendStarted.resolve();
            return firstSend.promise;
          }
          return Promise.resolve();
        },
      },
      generateCode: () => codes.shift() ?? '000000',
    });
    const input = { phoneE164: phone, context: trustedContext() };

    const delayedIssue = fixture.service.issue(input);
    await firstSendStarted.promise;
    fixture.advanceBy(60_000);
    await fixture.service.issue(input);
    firstSend.reject(new Error('SMS_PROVIDER_UNAVAILABLE'));

    await expect(delayedIssue).rejects.toThrow('SMS_PROVIDER_UNAVAILABLE');
    await expect(fixture.service.verify({ phoneE164: phone, code: '654321' })).resolves.toBe(true);
  });

  it.each([
    ['phone', { phone: 2, ip: 99, device: 99 }],
    ['ip', { phone: 99, ip: 2, device: 99 }],
    ['device', { phone: 99, ip: 99, device: 2 }],
  ] as const)(
    'enforces the %s time-window dimension using PII-safe keys',
    async (dimension, limits) => {
      const fixture = makeFixture({
        rateLimitPolicy: {
          cooldownMs: 0,
          windowMs: 60 * 60 * 1000,
          phoneLimit: limits.phone,
          ipLimit: limits.ip,
          deviceLimit: limits.device,
        },
      });

      const requests = [
        {
          phoneE164: phone,
          context: trustedContext('203.0.113.8', 'device-0'),
        },
        {
          phoneE164: dimension === 'phone' ? phone : '+8613900138000',
          context: trustedContext(
            dimension === 'ip' ? '203.0.113.8' : '203.0.113.9',
            dimension === 'device' ? 'device-0' : 'device-1',
          ),
        },
        {
          phoneE164: dimension === 'phone' ? phone : '+8615800138000',
          context: trustedContext(
            dimension === 'ip' ? '203.0.113.8' : '203.0.113.10',
            dimension === 'device' ? 'device-0' : 'device-2',
          ),
        },
      ] as const;

      await fixture.service.issue(requests[0]);
      await fixture.service.issue(requests[1]);
      await expect(fixture.service.issue(requests[2])).rejects.toMatchObject({
        code: 'SMS_RATE_LIMITED',
      });

      const serializedKeys = fixture.store.issueKeys.flat().join('|');
      expect(serializedKeys).not.toContain(phone);
      expect(serializedKeys).not.toContain('13800138000');
      expect(serializedKeys).not.toContain('203.0.113.8');
      expect(serializedKeys).not.toContain('device-a');
      expect(serializedKeys).not.toContain(createHash('sha256').update(phone).digest('hex'));
    },
  );

  it('snapshots the rate-limit policy so callers cannot mutate limits after construction', async () => {
    const policy = {
      cooldownMs: 0,
      windowMs: 60 * 60 * 1000,
      phoneLimit: 2,
      ipLimit: 99,
      deviceLimit: 99,
    };
    const fixture = makeFixture({ rateLimitPolicy: policy });
    policy.phoneLimit = 99;

    await fixture.service.issue({
      phoneE164: phone,
      context: trustedContext('203.0.113.8', 'device-0'),
    });
    await fixture.service.issue({
      phoneE164: phone,
      context: trustedContext('203.0.113.9', 'device-1'),
    });
    await expect(
      fixture.service.issue({
        phoneE164: phone,
        context: trustedContext('203.0.113.10', 'device-2'),
      }),
    ).rejects.toMatchObject({ code: 'SMS_RATE_LIMITED' });
  });

  it('rejects a zero-length rate-limit window that would disable Redis counters', () => {
    expect(() =>
      makeFixture({
        rateLimitPolicy: {
          cooldownMs: 0,
          windowMs: 0,
          phoneLimit: 5,
          ipLimit: 30,
          deviceLimit: 10,
        },
      }),
    ).toThrow('INVALID_SMS_RATE_LIMIT_POLICY');
  });

  it('rejects issuance when async KMS hashing consumes the five-minute lifetime', async () => {
    const fixture = makeFixture({}, { codeHashDelayMs: 5 * 60 * 1000 });

    await expect(
      fixture.service.issue({ phoneE164: phone, context: trustedContext() }),
    ).rejects.toMatchObject({ code: 'SMS_CHALLENGE_EXPIRED' });
    expect(fixture.store.challenges.size).toBe(0);
    expect(fixture.sender.sent).toEqual([]);
  });

  it('uses Redis-compatible fixed windows at the exact boundary', async () => {
    const fixture = makeFixture({
      rateLimitPolicy: {
        cooldownMs: 0,
        windowMs: 1_000,
        phoneLimit: 2,
        ipLimit: 99,
        deviceLimit: 99,
      },
    });
    await fixture.service.issue({ phoneE164: phone, context: trustedContext() });
    fixture.advanceBy(500);
    await fixture.service.issue({
      phoneE164: phone,
      context: trustedContext('203.0.113.9', 'device-b'),
    });
    fixture.advanceBy(500);

    await expect(
      fixture.service.issue({
        phoneE164: phone,
        context: trustedContext('203.0.113.10', 'device-c'),
      }),
    ).resolves.toBeUndefined();
    await expect(
      fixture.service.issue({
        phoneE164: phone,
        context: trustedContext('203.0.113.11', 'device-d'),
      }),
    ).resolves.toBeUndefined();
  });

  it('maps equivalent IPv6 spellings to the same IP limiter identifier', async () => {
    const fixture = makeFixture({
      rateLimitPolicy: {
        cooldownMs: 0,
        windowMs: 60_000,
        phoneLimit: 99,
        ipLimit: 1,
        deviceLimit: 99,
      },
    });
    await fixture.service.issue({
      phoneE164: phone,
      context: trustedContext('2001:0DB8:0:0:0:0:0:1', 'device-a'),
    });
    await expect(
      fixture.service.issue({
        phoneE164: '+8613900138000',
        context: trustedContext('2001:db8::1', 'device-b'),
      }),
    ).rejects.toMatchObject({ code: 'SMS_RATE_LIMITED' });
  });

  it('rejects a forged request context before creating Redis keys', async () => {
    const fixture = makeFixture();
    const forged = { canonicalIp: '203.0.113.8', canonicalDeviceId: 'device-a' };

    await expect(
      fixture.service.issue({ phoneE164: phone, context: forged as SmsRequestContext }),
    ).rejects.toMatchObject({ code: 'UNTRUSTED_SMS_REQUEST_CONTEXT' });
    expect(fixture.store.issueKeys).toEqual([]);
  });

  it.each(['ip', 'device'] as const)(
    'normalizes surrounding whitespace before hashing the %s dimension',
    async (dimension) => {
      const fixture = makeFixture({
        rateLimitPolicy: {
          cooldownMs: 0,
          windowMs: 60 * 60 * 1000,
          phoneLimit: 99,
          ipLimit: dimension === 'ip' ? 1 : 99,
          deviceLimit: dimension === 'device' ? 1 : 99,
        },
      });
      await fixture.service.issue({
        phoneE164: phone,
        context: trustedContext('203.0.113.8', 'device-0'),
      });

      await expect(
        fixture.service.issue({
          phoneE164: '+8613900138000',
          context: trustedContext(
            dimension === 'ip' ? ' 203.0.113.8 ' : '203.0.113.9',
            dimension === 'device' ? ' device-0 ' : 'device-1',
          ),
        }),
      ).rejects.toMatchObject({ code: 'SMS_RATE_LIMITED' });
    },
  );

  it.each([
    ['phone', '13800138000', '123456'],
    ['phone', '+85261234567', '123456'],
    ['code', phone, '12345'],
    ['code', phone, '12345a'],
  ])('rejects invalid %s input at the application boundary', async (_field, phoneE164, code) => {
    const { service } = makeFixture();

    await expect(service.verify({ phoneE164, code })).rejects.toMatchObject({
      code: _field === 'phone' ? 'INVALID_PHONE' : 'INVALID_SMS_CODE',
    });
  });
});
