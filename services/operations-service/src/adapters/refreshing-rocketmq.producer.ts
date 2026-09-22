import type { Producer, SessionCredentials } from 'rocketmq-client-nodejs';

type ProducerMessage = Parameters<Producer['send']>[0];
type ProducerTransaction = Parameters<Producer['send']>[1];
type ProducerReceipt = Awaited<ReturnType<Producer['send']>>;

export interface RocketMqProducerClient {
  startup(): Promise<void>;
  send(message: ProducerMessage, transaction?: ProducerTransaction): Promise<ProducerReceipt>;
  shutdown(): Promise<void>;
}

/** Rotates short-lived STS clients without dropping publishes accepted by the previous client. */
export class RefreshingRocketMqProducer implements Pick<Producer, 'startup' | 'send' | 'shutdown'> {
  private current: { client: RocketMqProducerClient; expiresAt: Date; sessionId: string } | null =
    null;
  private readonly retired = new Set<RocketMqProducerClient>();
  private readonly active = new Map<RocketMqProducerClient, number>();
  private readonly drainWaiters = new Map<RocketMqProducerClient, Set<() => void>>();
  private readonly stoppedClients = new Set<RocketMqProducerClient>();
  private readonly stoppingClients = new Map<RocketMqProducerClient, Promise<void>>();
  private readonly retirementTasks = new Set<Promise<void>>();
  private refreshInFlight: Promise<RocketMqProducerClient> | null = null;
  private stopInFlight: Promise<void> | null = null;
  private stopped = false;

  constructor(
    private readonly input: {
      credentials(): Promise<{ value: SessionCredentials; expiresAt: Date }>;
      create(credentials: SessionCredentials): RocketMqProducerClient;
      now?: () => Date;
      refreshBeforeMs?: number;
      onRetirementError?: (error: unknown) => void;
    },
  ) {}

  async startup(): Promise<void> {
    await this.ensureCurrent();
  }

  async send(
    message: ProducerMessage,
    transaction?: ProducerTransaction,
  ): Promise<ProducerReceipt> {
    const client = await this.ensureCurrent();
    if (this.stopped) throw new Error('BROKER_STOPPED');
    this.retain(client);
    try {
      return await client.send(message, transaction);
    } finally {
      this.release(client);
    }
  }

  shutdown(): Promise<void> {
    if (this.stopInFlight === null) {
      const stopping = this.stopInternal();
      this.stopInFlight = stopping;
      void stopping.then(undefined, () => {
        if (this.stopInFlight === stopping) this.stopInFlight = null;
      });
    }
    return this.stopInFlight;
  }

  private async stopInternal(): Promise<void> {
    this.stopped = true;
    const refresh = this.refreshInFlight;
    if (refresh !== null) await refresh.catch(() => undefined);
    const clients = this.allClients();
    await Promise.all([...clients].map((client) => this.waitForDrain(client)));
    const shutdowns = await Promise.allSettled(
      [...clients].map((client) => this.shutdownClient(client)),
    );
    await Promise.allSettled([...this.retirementTasks]);
    const failures = shutdowns.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failures.length > 0) {
      for (const failure of failures) this.reportRetirementError(failure.reason);
      throw new Error('BROKER_SHUTDOWN_FAILED');
    }
    this.current = null;
    this.retired.clear();
  }

  private async ensureCurrent(): Promise<RocketMqProducerClient> {
    if (this.stopped) throw new Error('BROKER_STOPPED');
    const now = (this.input.now ?? (() => new Date()))();
    if (
      this.current !== null &&
      this.current.expiresAt.getTime() - (this.input.refreshBeforeMs ?? 5 * 60_000) > now.getTime()
    )
      return this.current.client;
    const refresh = (this.refreshInFlight ??= this.rotate());
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }

  private async rotate(): Promise<RocketMqProducerClient> {
    const credentials = await this.input.credentials();
    const now = (this.input.now ?? (() => new Date()))();
    if (!Number.isFinite(credentials.expiresAt.getTime()) || credentials.expiresAt <= now)
      throw new Error('STS_CREDENTIALS_EXPIRED');
    const sessionId = credentialIdentity(credentials.value, credentials.expiresAt);
    if (this.current?.sessionId === sessionId) return this.current.client;
    const replacement = this.input.create(credentials.value);
    if (this.isStopped()) {
      await this.cleanupReplacement(replacement);
      throw new Error('BROKER_STOPPED');
    }
    try {
      await replacement.startup();
    } catch (error) {
      this.retired.add(replacement);
      try {
        await this.shutdownClient(replacement);
        this.retired.delete(replacement);
      } catch (cleanupError) {
        this.reportRetirementError(cleanupError);
      }
      throw error;
    }
    if (this.isStopped()) {
      await this.cleanupReplacement(replacement);
      throw new Error('BROKER_STOPPED');
    }

    const previous = this.current?.client;
    this.current = { client: replacement, expiresAt: credentials.expiresAt, sessionId };
    if (previous !== undefined) {
      this.retired.add(previous);
      const retirement = this.retireWhenDrained(previous);
      const tracked = retirement.then(
        () => {
          this.retirementTasks.delete(tracked);
        },
        (error: unknown) => {
          this.retirementTasks.delete(tracked);
          this.reportRetirementError(error);
        },
      );
      this.retirementTasks.add(tracked);
    }
    return replacement;
  }

  private async retireWhenDrained(client: RocketMqProducerClient): Promise<void> {
    await this.waitForDrain(client);
    if (!this.retired.has(client)) return;
    await this.shutdownClient(client);
    this.retired.delete(client);
  }

  private async cleanupReplacement(client: RocketMqProducerClient): Promise<void> {
    this.retired.add(client);
    try {
      await this.shutdownClient(client);
      this.retired.delete(client);
    } catch (error) {
      this.reportRetirementError(error);
    }
  }

  private retain(client: RocketMqProducerClient): void {
    this.active.set(client, (this.active.get(client) ?? 0) + 1);
  }

  private release(client: RocketMqProducerClient): void {
    const remaining = (this.active.get(client) ?? 1) - 1;
    if (remaining > 0) {
      this.active.set(client, remaining);
      return;
    }
    this.active.delete(client);
    for (const resolve of this.drainWaiters.get(client) ?? []) resolve();
    this.drainWaiters.delete(client);
  }

  private waitForDrain(client: RocketMqProducerClient): Promise<void> {
    if ((this.active.get(client) ?? 0) === 0) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.drainWaiters.get(client) ?? new Set<() => void>();
      waiters.add(resolve);
      this.drainWaiters.set(client, waiters);
    });
  }

  private async shutdownClient(client: RocketMqProducerClient): Promise<void> {
    if (this.stoppedClients.has(client)) return;
    const existing = this.stoppingClients.get(client);
    if (existing !== undefined) return existing;
    const stopping = client.shutdown();
    this.stoppingClients.set(client, stopping);
    try {
      await stopping;
      this.stoppedClients.add(client);
    } finally {
      if (this.stoppingClients.get(client) === stopping) this.stoppingClients.delete(client);
    }
  }

  private allClients(): Set<RocketMqProducerClient> {
    const clients = new Set(this.retired);
    if (this.current !== null) clients.add(this.current.client);
    return clients;
  }

  private isStopped(): boolean {
    return this.stopped;
  }

  private reportRetirementError(error: unknown): void {
    try {
      this.input.onRetirementError?.(error);
    } catch {
      // Observability callbacks cannot turn a handled client-retirement failure into a process rejection.
    }
  }
}

function credentialIdentity(value: SessionCredentials, expiresAt: Date): string {
  return `${value.accessKey}\0${value.securityToken ?? ''}\0${expiresAt.toISOString()}`;
}
