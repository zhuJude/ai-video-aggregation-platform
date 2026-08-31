import type { Writable } from 'node:stream';
import pino, { type Logger, type LoggerOptions } from 'pino';

const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'paymentciphertext',
  'phone',
  'secret',
  'signature',
  'token',
  'verificationcode',
  '验证码',
  '密钥',
  '手机号',
  '令牌',
]);
const PHONE_PATTERN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const REDACTED = '[REDACTED]';

export interface SafeLoggerOptions {
  service: string;
  environment: string;
  version: string;
  successSampleRate?: number;
  random?: () => number;
  stream?: Writable;
}

function normalizedKey(key: string): string {
  return key.replaceAll(/[-_.]/g, '').toLowerCase();
}

function sanitize(value: unknown, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return value.replaceAll(PHONE_PATTERN, REDACTED);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, seen));
  if (value instanceof Error) {
    return {
      name: value.name,
      message: sanitize(value.message, seen),
      stack: sanitize(value.stack, seen),
    };
  }
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    sanitized[key] = SENSITIVE_KEYS.has(normalizedKey(key))
      ? REDACTED
      : sanitize(nestedValue, seen);
  }
  seen.delete(value);
  return sanitized;
}

function shouldAlwaysRetain(payload: unknown, level: number): boolean {
  if (level >= 50 || payload === null || typeof payload !== 'object') return level >= 50;
  const record = payload as Record<string, unknown>;
  return (
    record.eventCategory === 'financial' ||
    record.eventCategory === 'audit' ||
    record.auditReference !== undefined ||
    record.errorCode !== undefined ||
    record.err !== undefined
  );
}

export function createSafeLogger(options: SafeLoggerOptions): Logger {
  const successSampleRate = options.successSampleRate ?? 1;
  if (successSampleRate < 0 || successSampleRate > 1) {
    throw new RangeError('successSampleRate must be between 0 and 1');
  }
  const random = options.random ?? Math.random;
  const loggerOptions: LoggerOptions = {
    base: {
      service: options.service,
      environment: options.environment,
      version: options.version,
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    hooks: {
      logMethod(args, method, level) {
        const payload = args[0];
        const successfulHighVolume =
          payload !== null &&
          typeof payload === 'object' &&
          (payload as Record<string, unknown>).sample === 'success';
        if (
          successfulHighVolume &&
          !shouldAlwaysRetain(payload, level) &&
          random() >= successSampleRate
        ) {
          return;
        }
        method.apply(this, args.map((argument) => sanitize(argument)) as Parameters<typeof method>);
      },
    },
  };
  return options.stream === undefined
    ? pino(loggerOptions)
    : pino(loggerOptions, options.stream as NodeJS.WritableStream);
}
