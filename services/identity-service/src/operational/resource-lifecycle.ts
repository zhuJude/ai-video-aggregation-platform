export type IdentityResourceName =
  | 'health'
  | 'watchdog'
  | 'readiness_redis'
  | 'redis'
  | 'readiness_database'
  | 'database'
  | 'cloud';

export const identityResourcePhase: Readonly<Record<IdentityResourceName, number>> = Object.freeze({
  health: 0,
  watchdog: 1,
  readiness_redis: 2,
  redis: 3,
  readiness_database: 4,
  database: 5,
  cloud: 6,
});

export interface IdentityResourceLifecycleObserver {
  resourceClosed?(resource: IdentityResourceName): void;
}

interface ResourceEntry {
  readonly name: IdentityResourceName;
  readonly phase: number;
  readonly close: () => Promise<void>;
}

export class IdentityResourceLifecycle {
  private readonly entries = new Map<IdentityResourceName, ResourceEntry>();
  private closing: Promise<void> | undefined;

  constructor(private readonly observer: IdentityResourceLifecycleObserver = {}) {}

  has(name: IdentityResourceName): boolean { return this.entries.has(name); }

  register(name: IdentityResourceName, close: () => void | Promise<void>): void {
    if (this.closing) throw stableError('RESOURCE_LIFECYCLE_ALREADY_CLOSING');
    if (this.entries.has(name)) throw stableError('RESOURCE_ALREADY_REGISTERED');
    let result: Promise<void> | undefined;
    this.entries.set(name, {
      name,
      phase: identityResourcePhase[name],
      close: () => {
        result ??= boundedClose(close).finally(() => { this.notifyClosed(name); });
        return result;
      },
    });
  }

  close(): Promise<void> {
    this.closing ??= this.closeAll();
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    const failures: Array<{ readonly resource: IdentityResourceName; readonly reason: unknown }> = [];
    const phases = [...new Set([...this.entries.values()].map(({ phase }) => phase))].sort((left, right) => left - right);
    for (const phase of phases) {
      const entries = [...this.entries.values()].filter((entry) => entry.phase === phase);
      const results = await Promise.allSettled(entries.map(({ close }) => close()));
      results.forEach((result, index) => {
        if (result.status === 'rejected') failures.push({ resource: entries[index]?.name ?? 'cloud', reason: result.reason as unknown });
      });
    }
    if (failures.length > 0) {
      process.stderr.write(`${JSON.stringify({ level: 'error', event: 'runtime_shutdown_failed', code: 'RUNTIME_RESOURCE_CLOSE_FAILED', resources: failures.map(({ resource }) => resource) })}\n`);
      throw new AggregateError(failures.map(({ reason }) => reason), 'RUNTIME_RESOURCE_CLOSE_FAILED');
    }
  }

  private notifyClosed(name: IdentityResourceName): void {
    try { this.observer.resourceClosed?.(name); }
    catch { process.emitWarning('RESOURCE_LIFECYCLE_OBSERVER_FAILED', { code: 'RESOURCE_LIFECYCLE_OBSERVER_FAILED' }); }
  }
}

async function boundedClose(close: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { reject(stableError('RESOURCE_CLOSE_TIMEOUT')); }, timeoutMs);
    timer.unref();
  });
  try { await Promise.race([Promise.resolve().then(close), timeout]); }
  finally { if (timer) clearTimeout(timer); }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
