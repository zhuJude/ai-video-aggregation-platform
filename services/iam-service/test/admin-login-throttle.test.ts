import { describe, expect, it } from 'vitest';

import { MemoryAdminLoginThrottle } from '../src/adapters/memory-admin-login-throttle.js';

describe('MemoryAdminLoginThrottle attempt reservations', () => {
  it('admits at most the remaining budget under concurrency and locks after committed failures', async () => {
    const throttle = new MemoryAdminLoginThrottle({
      maxFailures: 5,
      failureWindowMs: 60_000,
      lockDurationMs: 120_000,
      reservationTtlMs: 10_000,
    });
    const now = new Date('2026-09-01T08:00:00Z');
    const attempts = await Promise.all(
      Array.from({ length: 20 }, () => throttle.reserve('ops@example.com', now)),
    );
    const permits = attempts.filter((permit) => permit !== null);
    expect(permits).toHaveLength(5);
    await Promise.all(permits.map((permit) => throttle.commitFailure(permit, now)));
    await expect(throttle.reserve('ops@example.com', now)).resolves.toBeNull();
  });

  it('makes permits unforgeable and single-use while release and expiry restore capacity', async () => {
    const throttle = new MemoryAdminLoginThrottle({
      maxFailures: 1,
      failureWindowMs: 60_000,
      lockDurationMs: 120_000,
      reservationTtlMs: 10_000,
    });
    const now = new Date('2026-09-01T08:00:00Z');
    const released = await throttle.reserve('release@example.com', now);
    if (!released) throw new Error('EXPECTED_PERMIT');
    await throttle.release(released);
    await expect(throttle.release(released)).rejects.toMatchObject({
      code: 'INVALID_LOGIN_ATTEMPT_PERMIT',
    });
    await expect(
      throttle.commitFailure({ ...released, token: 'forged' }, now),
    ).rejects.toMatchObject({ code: 'INVALID_LOGIN_ATTEMPT_PERMIT' });
    await expect(throttle.reserve('release@example.com', now)).resolves.not.toBeNull();

    const crashed = await throttle.reserve('crash@example.com', now);
    expect(crashed).not.toBeNull();
    await expect(
      throttle.reserve('crash@example.com', new Date(now.getTime() + 10_001)),
    ).resolves.not.toBeNull();
  });

  it('clears committed failures on a successful reserved attempt', async () => {
    const throttle = new MemoryAdminLoginThrottle({ maxFailures: 2 });
    const now = new Date('2026-09-01T08:00:00Z');
    const failure = await throttle.reserve('success@example.com', now);
    if (!failure) throw new Error('EXPECTED_FAILURE_PERMIT');
    await throttle.commitFailure(failure, now);
    const success = await throttle.reserve('success@example.com', now);
    if (!success) throw new Error('EXPECTED_SUCCESS_PERMIT');
    await throttle.commitSuccess(success);
    const next = await throttle.reserve('success@example.com', now);
    expect(next).not.toBeNull();
  });

  it('counts a failed attempt reported after its execution reservation expired', async () => {
    const throttle = new MemoryAdminLoginThrottle({
      maxFailures: 1,
      reservationTtlMs: 30,
      permitReportGraceMs: 5_000,
    });
    const started = new Date('2026-09-01T08:00:00Z');
    const permit = await throttle.reserve('slow@example.com', started);
    if (!permit) throw new Error('EXPECTED_PERMIT');
    const completed = new Date(started.getTime() + 60);
    await throttle.commitFailure(permit, completed);
    await expect(throttle.reserve('slow@example.com', completed)).resolves.toBeNull();
  });
});
