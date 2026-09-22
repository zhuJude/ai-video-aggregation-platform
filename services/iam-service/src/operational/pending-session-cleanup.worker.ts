export interface PendingSessionCleanupRepository {
  cleanupExpiredPendingSessions(now: Date, limit?: number): Promise<number>;
}
export interface PendingSessionCleanupMetrics {
  increment(name: 'iam_pending_cleanup_failures_total'): void;
  add(name: 'iam_pending_sessions_cleaned_total', value: number): void;
}
export interface PendingSessionCleanupObserver {
  recordFailure(event: { readonly code: 'IAM_PENDING_CLEANUP_FAILED' }): void | Promise<void>;
}

export class PendingSessionCleanupWorker {
  private timer: NodeJS.Timeout | undefined;
  private current: Promise<void> | undefined;
  private available = false;
  private closed = false;
  constructor(
    private readonly repository: PendingSessionCleanupRepository,
    private readonly metrics: PendingSessionCleanupMetrics,
    private readonly observer: PendingSessionCleanupObserver,
    private readonly intervalMs: number,
    private readonly batchSize: number,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 3_600_000)
      throw stableError('INVALID_PENDING_CLEANUP_INTERVAL');
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500)
      throw stableError('INVALID_PENDING_CLEANUP_BATCH');
  }
  start(): void {
    if (this.closed || this.timer) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    this.timer.unref();
    void this.runOnce();
  }
  runOnce(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.current) return this.current;
    const work = this.repository
      .cleanupExpiredPendingSessions(this.now(), this.batchSize)
      .then((count) => {
        if (!Number.isSafeInteger(count) || count < 0 || count > this.batchSize)
          throw stableError('INVALID_PENDING_CLEANUP_RESULT');
        this.metrics.add('iam_pending_sessions_cleaned_total', count);
        this.available = true;
      })
      .catch(async () => {
        this.available = false;
        this.metrics.increment('iam_pending_cleanup_failures_total');
        try {
          await this.observer.recordFailure({ code: 'IAM_PENDING_CLEANUP_FAILED' });
        } catch {
          process.emitWarning('IAM_PENDING_CLEANUP_OBSERVER_FAILED', {
            code: 'IAM_PENDING_CLEANUP_OBSERVER_FAILED',
          });
        }
      });
    const wrapped = work.finally(() => {
      if (this.current === wrapped) this.current = undefined;
    });
    this.current = wrapped;
    return wrapped;
  }
  healthy(): boolean {
    return !this.closed && this.available;
  }
  async close(): Promise<void> {
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.current;
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
