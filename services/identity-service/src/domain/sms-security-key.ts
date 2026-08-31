export const SMS_SECURITY_REDIS_HASH_TAG = '{sms-security}';

/**
 * All bounded SMS security state deliberately shares one Redis Cluster/Tair slot so the issue
 * Lua transaction can atomically update its challenge and the small, TTL-bound limiter set.
 */
export function smsChallengeKey(identifier: string): string {
  validateIdentifier(identifier);
  return `sms:challenge:${SMS_SECURITY_REDIS_HASH_TAG}:${identifier}`;
}

export function smsRateKey(dimension: string, identifier: string): string {
  if (!/^[a-z-]+$/.test(dimension)) throw new Error('INVALID_SMS_RATE_DIMENSION');
  validateIdentifier(identifier);
  return `sms:rate:${SMS_SECURITY_REDIS_HASH_TAG}:${dimension}:${identifier}`;
}

export function isSmsSecurityRedisKey(key: string): boolean {
  return (
    /^sms:challenge:\{sms-security\}:[a-f0-9]{64}$/.test(key) ||
    /^sms:rate:\{sms-security\}:[a-z-]+:[a-f0-9]{64}$/.test(key)
  );
}

function validateIdentifier(identifier: string): void {
  if (!/^[a-f0-9]{64}$/.test(identifier)) throw new Error('INVALID_SMS_SECURITY_IDENTIFIER');
}
