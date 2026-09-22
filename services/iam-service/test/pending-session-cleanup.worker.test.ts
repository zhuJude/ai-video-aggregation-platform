import { afterEach, describe, expect, it, vi } from 'vitest';
import { PendingSessionCleanupWorker } from '../src/operational/pending-session-cleanup.worker.js';

function deferred<T>() {
  let resolveValue!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { resolveValue = resolve; });
  return { promise, resolve: resolveValue };
}

describe('PendingSessionCleanupWorker', () => {
  afterEach(() => vi.useRealTimers());
  it('runs bounded batches without overlap and awaits the active run on close', async () => {
    vi.useFakeTimers();
    const pending = deferred<number>();
    const cleanup = vi.fn(() => pending.promise);
    const add = vi.fn();
    const worker = new PendingSessionCleanupWorker(
      { cleanupExpiredPendingSessions: cleanup },
      { increment: vi.fn(), add },
      { recordFailure: vi.fn() },
      1_000,
      25,
      () => new Date('2026-09-02T00:00:00.000Z'),
    );
    expect(worker.healthy()).toBe(false);
    worker.start();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(worker.healthy()).toBe(false);
    expect(cleanup).toHaveBeenCalledWith(new Date('2026-09-02T00:00:00.000Z'), 25);
    let closed = false;
    const closing = worker.close().then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    pending.resolve(7);
    await closing;
    expect(add).toHaveBeenCalledWith('iam_pending_sessions_cleaned_total', 7);
    expect(worker.healthy()).toBe(false);
  });

  it('reports a non-PII failure, becomes unhealthy, and recovers on success', async () => {
    const increment = vi.fn();
    const add = vi.fn();
    const recordFailure = vi.fn(() => Promise.resolve());
    let fail = true;
    const worker = new PendingSessionCleanupWorker(
      { cleanupExpiredPendingSessions: () => fail ? Promise.reject(new Error('database url must not leak')) : Promise.resolve(2) },
      { increment, add },
      { recordFailure },
      60_000,
      100,
    );
    await worker.runOnce();
    expect(worker.healthy()).toBe(false);
    expect(increment).toHaveBeenCalledWith('iam_pending_cleanup_failures_total');
    expect(recordFailure).toHaveBeenCalledWith({ code: 'IAM_PENDING_CLEANUP_FAILED' });
    expect(JSON.stringify(recordFailure.mock.calls)).not.toContain('database url');
    fail = false;
    await worker.runOnce();
    expect(worker.healthy()).toBe(true);
    expect(add).toHaveBeenCalledWith('iam_pending_sessions_cleaned_total', 2);
    await worker.close();
  });
});
