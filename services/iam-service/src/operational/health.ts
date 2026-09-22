export type DependencyState = 'up' | 'down' | 'timeout' | 'adapter_stuck';
export interface ReadinessCheck {
  readonly name: string;
  readonly check: (signal: AbortSignal) => Promise<boolean>;
}
export interface ReadinessObserver {
  adapterStuck(name: string): void;
}

export class EventLoopWatchdog {
  private lastTick = Date.now();
  private delayMs = 0;
  private readonly timer: NodeJS.Timeout;
  constructor(
    private readonly thresholdMs = 250,
    intervalMs = 50,
  ) {
    if (!Number.isSafeInteger(thresholdMs) || thresholdMs < 10)
      throw stableError('INVALID_STALL_THRESHOLD');
    this.timer = setInterval(() => {
      const current = Date.now();
      this.delayMs = Math.max(0, current - this.lastTick - intervalMs);
      this.lastTick = current;
    }, intervalMs);
    this.timer.unref();
  }
  healthy(): boolean {
    return this.delayMs <= this.thresholdMs;
  }
  observedDelayMs(): number {
    return this.delayMs;
  }
  close(): void {
    clearInterval(this.timer);
  }
}

export class ServiceHealth {
  private readonly probes: readonly BoundedProbe[];
  constructor(
    checks: readonly ReadinessCheck[],
    private readonly watchdog: Pick<EventLoopWatchdog, 'healthy'>,
    timeoutMs = 1_000,
    cacheMs = timeoutMs,
    abortGraceMs = 500,
    observer?: ReadinessObserver,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 10_000)
      throw stableError('INVALID_READINESS_TIMEOUT');
    if (!Number.isSafeInteger(cacheMs) || cacheMs < 0 || cacheMs > 60_000)
      throw stableError('INVALID_READINESS_CACHE');
    if (!Number.isSafeInteger(abortGraceMs) || abortGraceMs < 10 || abortGraceMs > 10_000)
      throw stableError('INVALID_READINESS_ABORT_GRACE');
    const names = checks.map(({ name }) => name);
    if (
      names.some((name) => !/^[a-z][a-z0-9_]{1,31}$/.test(name)) ||
      new Set(names).size !== names.length
    )
      throw stableError('INVALID_READINESS_CHECK');
    this.probes = checks.map(
      ({ name, check }) =>
        new BoundedProbe(name, check, timeoutMs, cacheMs, abortGraceMs, observer),
    );
  }
  liveness() {
    const healthy = this.watchdog.healthy();
    return { statusCode: healthy ? 200 : 503, body: { status: healthy ? 'live' : 'stalled' } };
  }
  async readiness() {
    const entries = await Promise.all(
      this.probes.map(async (probe) => [probe.name, await probe.read()] as const),
    );
    const checks = Object.fromEntries(entries) as Record<string, DependencyState>;
    const ready = entries.every(([, state]) => state === 'up');
    return {
      statusCode: ready ? 200 : 503,
      body: { status: ready ? 'ready' : 'not_ready', checks },
    };
  }
  close(): void {
    for (const probe of this.probes) probe.close();
  }
}

class BoundedProbe {
  private inFlight: Promise<DependencyState> | undefined;
  private activeOperation: Promise<DependencyState> | undefined;
  private controller: AbortController | undefined;
  private abortGraceTimer: NodeJS.Timeout | undefined;
  private adapterStuck = false;
  private cached: { readonly state: DependencyState; readonly expiresAt: number } | undefined;
  private closed = false;
  constructor(
    readonly name: string,
    private readonly check: (signal: AbortSignal) => Promise<boolean>,
    private readonly timeoutMs: number,
    private readonly cacheMs: number,
    private readonly abortGraceMs: number,
    private readonly observer?: ReadinessObserver,
  ) {}
  read(): Promise<DependencyState> {
    if (this.closed) return Promise.resolve('down');
    if (this.cached && this.cached.expiresAt > Date.now())
      return Promise.resolve(this.cached.state);
    if (this.inFlight) return this.inFlight;
    if (this.activeOperation)
      return Promise.resolve(this.adapterStuck ? 'adapter_stuck' : 'timeout');
    this.adapterStuck = false;
    const controller = new AbortController();
    this.controller = controller;
    const operation = invokeCheck(this.check, controller.signal);
    this.activeOperation = operation;
    void operation.then(() => {
      if (this.abortGraceTimer) clearTimeout(this.abortGraceTimer);
      this.abortGraceTimer = undefined;
      if (this.activeOperation === operation) this.activeOperation = undefined;
      if (this.controller === controller) this.controller = undefined;
    });
    const running = settleCheck(operation, controller, this.timeoutMs, () => {
      this.abortGraceTimer = setTimeout(() => {
        if (this.activeOperation !== operation || this.adapterStuck) return;
        this.adapterStuck = true;
        this.cached = { state: 'adapter_stuck', expiresAt: Date.now() + this.cacheMs };
        this.observer?.adapterStuck(this.name);
      }, this.abortGraceMs);
      this.abortGraceTimer.unref();
    }).then((state) => {
      this.cached = { state, expiresAt: Date.now() + this.cacheMs };
      return state;
    });
    const wrapped = running.finally(() => {
      if (this.inFlight === wrapped) this.inFlight = undefined;
    });
    this.inFlight = wrapped;
    return wrapped;
  }
  close(): void {
    this.closed = true;
    this.cached = undefined;
    if (this.abortGraceTimer) clearTimeout(this.abortGraceTimer);
    this.abortGraceTimer = undefined;
    this.controller?.abort();
  }
}

async function settleCheck(
  operation: Promise<DependencyState>,
  controller: AbortController,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<DependencyState> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<DependencyState>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
      queueMicrotask(() => {
        controller.abort();
        onTimeout();
      });
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function invokeCheck(
  check: (signal: AbortSignal) => Promise<boolean>,
  signal: AbortSignal,
): Promise<DependencyState> {
  return Promise.resolve()
    .then(() => check(signal))
    .then((value) => (value ? ('up' as const) : ('down' as const)))
    .catch(() => 'down' as const);
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
