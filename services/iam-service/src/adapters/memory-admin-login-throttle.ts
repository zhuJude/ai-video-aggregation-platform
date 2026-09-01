import { randomBytes } from 'node:crypto';

import type { AdminLoginAttemptPermit, AdminLoginThrottle } from '../ports/admin-login-throttle.js';

export interface MemoryAdminLoginThrottleOptions {
  readonly maxFailures?: number;
  readonly failureWindowMs?: number;
  readonly lockDurationMs?: number;
  readonly reservationTtlMs?: number;
  readonly permitReportGraceMs?: number;
}

interface Budget {
  failures: number;
  windowStartedMs: number;
  lockedUntilMs: number;
}

export class MemoryAdminLoginThrottle implements AdminLoginThrottle {
  private readonly budgets = new Map<string, Budget>();
  private readonly reservations = new Map<
    string,
    { subject: string; expiresAtMs: number; forgetAtMs: number }
  >();
  private tail = Promise.resolve();
  private readonly maxFailures: number;
  private readonly failureWindowMs: number;
  private readonly lockDurationMs: number;
  private readonly reservationTtlMs: number;
  private readonly permitReportGraceMs: number;

  constructor(options: MemoryAdminLoginThrottleOptions = {}) {
    this.maxFailures = positive(options.maxFailures ?? 5);
    this.failureWindowMs = positive(options.failureWindowMs ?? 15 * 60_000);
    this.lockDurationMs = positive(options.lockDurationMs ?? 15 * 60_000);
    this.reservationTtlMs = positive(options.reservationTtlMs ?? 30_000);
    this.permitReportGraceMs = positive(options.permitReportGraceMs ?? 5 * 60_000);
  }

  reserve(subject: string, now: Date): Promise<AdminLoginAttemptPermit | null> {
    return this.exclusive(() => {
      const nowMs = validTime(now);
      this.expire(nowMs);
      const budget = this.currentBudget(subject, nowMs);
      const inflight = [...this.reservations.values()].filter(
        (value) => value.subject === subject && value.expiresAtMs > nowMs,
      ).length;
      if (budget.lockedUntilMs > nowMs || budget.failures + inflight >= this.maxFailures)
        return null;
      const token = randomBytes(32).toString('base64url');
      this.reservations.set(token, {
        subject,
        expiresAtMs: nowMs + this.reservationTtlMs,
        forgetAtMs: nowMs + this.reservationTtlMs + this.permitReportGraceMs,
      });
      return Object.freeze({ subject, token });
    });
  }

  commitFailure(permit: AdminLoginAttemptPermit, now: Date): Promise<void> {
    return this.exclusive(() => {
      const nowMs = validTime(now);
      this.consume(permit, nowMs);
      const budget = this.currentBudget(permit.subject, nowMs);
      budget.failures += 1;
      if (budget.failures >= this.maxFailures) budget.lockedUntilMs = nowMs + this.lockDurationMs;
      this.budgets.set(permit.subject, budget);
    });
  }

  commitSuccess(permit: AdminLoginAttemptPermit): Promise<void> {
    return this.exclusive(() => {
      this.consume(permit, Date.now(), false);
      this.budgets.delete(permit.subject);
    });
  }

  release(permit: AdminLoginAttemptPermit): Promise<void> {
    return this.exclusive(() => {
      this.consume(permit, Date.now(), false);
    });
  }

  private currentBudget(subject: string, nowMs: number): Budget {
    const existing = this.budgets.get(subject);
    if (!existing || existing.windowStartedMs + this.failureWindowMs <= nowMs) {
      return { failures: 0, windowStartedMs: nowMs, lockedUntilMs: 0 };
    }
    return existing;
  }

  private expire(nowMs: number): void {
    for (const [token, reservation] of this.reservations) {
      if (reservation.forgetAtMs <= nowMs) this.reservations.delete(token);
    }
  }

  private consume(permit: AdminLoginAttemptPermit, nowMs: number, expire = true): void {
    if (expire) this.expire(nowMs);
    const stored = this.reservations.get(permit.token);
    if (!stored || stored.subject !== permit.subject)
      throw stableError('INVALID_LOGIN_ATTEMPT_PERMIT');
    this.reservations.delete(permit.token);
  }

  private async exclusive<T>(operation: () => T): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return operation();
    } finally {
      release();
    }
  }
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw stableError('INVALID_THROTTLE_POLICY');
  return value;
}

function validTime(now: Date): number {
  const value = now.getTime();
  if (!Number.isSafeInteger(value) || value < 0) throw stableError('INVALID_THROTTLE_TIME');
  return value;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
