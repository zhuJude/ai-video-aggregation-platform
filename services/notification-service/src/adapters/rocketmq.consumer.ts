import type { NotificationMetrics } from '../runtime/production.js';
import {
  Producer,
  SimpleConsumer,
  type MessageView,
  type SessionCredentials,
} from 'rocketmq-client-nodejs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const NOTIFICATION_EVENT_TAG_EXPRESSION =
  'task.succeeded.v1 || task.failed.v1 || payment.succeeded.v1 || payment.failed.v1 || ticket.replied.v1 || wallet.low-balance.v1';

export function uniqueHealthConsumerGroup(
  base: string,
  podIdentity = process.env.POD_UID ?? process.env.HOSTNAME ?? 'local',
  suffix = randomBytes(4).toString('hex'),
): string {
  const prefix = `${base}-health`.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-');
  const identity = createHash('sha256')
    .update(`${base}\0${podIdentity}\0${suffix}`)
    .digest('hex')
    .slice(0, 16);
  return `${prefix.slice(0, 47)}-${identity}`;
}

export interface RocketMqMessage {
  id: string;
  body: Uint8Array;
  deliveryAttempts: number;
  bornAt: number;
}

export interface RocketMqTransport {
  start(): Promise<void>;
  receive(maxMessages: number): Promise<RocketMqMessage[]>;
  ack(message: RocketMqMessage): Promise<void>;
  nack(message: RocketMqMessage): Promise<void>;
  publishDlq(message: RocketMqMessage, reason: string): Promise<void>;
  ping(): Promise<void>;
  stopPulling(): Promise<void>;
  stop(): Promise<void>;
}

type ConsumerClient = Pick<
  SimpleConsumer,
  'startup' | 'shutdown' | 'receive' | 'ack' | 'changeInvisibleDuration'
>;
type ProducerClient = Pick<Producer, 'startup' | 'shutdown' | 'send'>;

export class ApacheRocketMqTransport implements RocketMqTransport {
  private readonly consumer: ConsumerClient;
  private readonly dlqProducer: ProducerClient;
  private readonly healthConsumer: ConsumerClient;
  private readonly received = new Map<string, MessageView>();
  private started = false;
  private pulling = false;
  private stopped = false;
  private startInFlight: Promise<void> | null = null;
  private stopInFlight: Promise<void> | null = null;
  private clientsStopInFlight: Promise<void> | null = null;

  constructor(
    private readonly config: {
      endpoints: string;
      namespace: string;
      consumerGroup: string;
      topic: string;
      dlqTopic: string;
      healthTopic: string;
      healthConsumerGroup: string;
      sessionCredentials?: SessionCredentials;
      invisibleDurationMs?: number;
      nackDelayMs?: number;
      clients?: {
        consumer: ConsumerClient;
        healthConsumer: ConsumerClient;
        dlqProducer: ProducerClient;
      };
    },
  ) {
    const connection = {
      endpoints: config.endpoints,
      namespace: config.namespace,
      ...(config.sessionCredentials === undefined
        ? {}
        : { sessionCredentials: config.sessionCredentials }),
    };
    this.consumer =
      config.clients?.consumer ??
      new SimpleConsumer({
        ...connection,
        consumerGroup: config.consumerGroup,
        subscriptions: new Map([[config.topic, NOTIFICATION_EVENT_TAG_EXPRESSION]]),
        awaitDuration: 1_000,
      });
    this.healthConsumer =
      config.clients?.healthConsumer ??
      new SimpleConsumer({
        ...connection,
        consumerGroup: config.healthConsumerGroup,
        subscriptions: new Map([[config.healthTopic, 'notification-health']]),
        awaitDuration: 1_000,
      });
    this.dlqProducer =
      config.clients?.dlqProducer ?? new Producer({ ...connection, topic: config.dlqTopic });
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.stopped) throw new Error('BROKER_STOPPED');
    this.startInFlight ??= this.startInternal();
    return this.startInFlight;
  }

  private async startInternal(): Promise<void> {
    const results = await Promise.allSettled([
      this.consumer.startup(),
      this.healthConsumer.startup(),
      this.dlqProducer.startup(),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (failure !== undefined) {
      await this.stopClients();
      throw failure.reason;
    }
    if (this.stopped) {
      await this.stopClients();
      throw new Error('BROKER_STOPPED');
    }
    this.started = true;
    this.pulling = true;
  }

  async receive(maxMessages: number): Promise<RocketMqMessage[]> {
    if (!this.pulling) return [];
    const messages = await this.consumer.receive(
      maxMessages,
      this.config.invisibleDurationMs ?? 30_000,
    );
    return messages.map((message) => {
      this.received.set(message.messageId, message);
      return {
        id: message.messageId,
        body: message.body,
        deliveryAttempts: message.deliveryAttempt ?? 1,
        bornAt: message.bornTimestamp?.getTime() ?? Date.now(),
      };
    });
  }

  async ack(message: RocketMqMessage): Promise<void> {
    const raw = this.required(message);
    await this.consumer.ack(raw);
    this.received.delete(message.id);
  }

  async nack(message: RocketMqMessage): Promise<void> {
    await this.consumer.changeInvisibleDuration(
      this.required(message),
      this.config.nackDelayMs ?? 5_000,
    );
  }

  async publishDlq(message: RocketMqMessage, reason: string): Promise<void> {
    await this.dlqProducer.send({
      topic: this.config.dlqTopic,
      tag: 'notification-failed',
      keys: [message.id],
      properties: new Map([
        ['failure-reason', reason],
        ['original-topic', this.config.topic],
      ]),
      body: Buffer.from(message.body),
    });
  }

  async ping(): Promise<void> {
    if (!this.started) throw new Error('BROKER_UNAVAILABLE');
    const nonce = randomUUID();
    await this.dlqProducer.send({
      topic: this.config.healthTopic,
      tag: 'notification-health',
      keys: [nonce],
      body: Buffer.from(nonce),
    });
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      const messages = await this.healthConsumer.receive(8, 5_000);
      let matched = false;
      for (const message of messages) {
        matched ||= Buffer.from(message.body).toString('utf8') === nonce;
        await this.healthConsumer.ack(message);
      }
      if (matched) return;
    }
    throw new Error('BROKER_HEARTBEAT_TIMEOUT');
  }

  stopPulling(): Promise<void> {
    this.pulling = false;
    return Promise.resolve();
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.stopInFlight ??= this.stopInternal();
    return this.stopInFlight;
  }

  private async stopInternal(): Promise<void> {
    this.pulling = false;
    await this.startInFlight?.catch(() => undefined);
    await this.stopClients();
    this.received.clear();
    this.started = false;
  }

  private stopClients(): Promise<void> {
    this.clientsStopInFlight ??= Promise.allSettled([
      this.consumer.shutdown(),
      this.healthConsumer.shutdown(),
      this.dlqProducer.shutdown(),
    ]).then(() => undefined);
    return this.clientsStopInFlight;
  }

  private required(message: RocketMqMessage): MessageView {
    const raw = this.received.get(message.id);
    if (raw === undefined) throw new Error('ROCKETMQ_RECEIPT_NOT_FOUND');
    return raw;
  }
}

export class RefreshingRocketMqTransport implements RocketMqTransport {
  private current: {
    transport: RocketMqTransport;
    expiresAt: Date;
    sessionId: string;
  } | null = null;
  private readonly routes = new Map<string, RocketMqTransport>();
  private readonly retired = new Set<RocketMqTransport>();
  private readonly activeOperations = new Map<RocketMqTransport, number>();
  private readonly drainWaiters = new Map<RocketMqTransport, Set<() => void>>();
  private readonly stoppedTransports = new Set<RocketMqTransport>();
  private readonly retirementTasks = new Set<Promise<void>>();
  private refreshInFlight: Promise<RocketMqTransport> | null = null;
  private stopInFlight: Promise<void> | null = null;
  private pulling = true;
  private stopped = false;

  constructor(
    private readonly input: {
      credentials(): Promise<{ value: SessionCredentials; expiresAt: Date }>;
      create(credentials: SessionCredentials): RocketMqTransport;
      now?: () => Date;
      refreshBeforeMs?: number;
      settlementAttempts?: number;
      settlementRetryMs?: number;
      stopDrainTimeoutMs?: number;
      onRetirementError?: (error: unknown) => void;
      onSettlementError?: (error: unknown) => void;
    },
  ) {}

  async start(): Promise<void> {
    await this.ensureCurrent();
  }
  async receive(maxMessages: number): Promise<RocketMqMessage[]> {
    if (!this.pulling) return [];
    const transport = await this.acquireCurrent();
    try {
      const messages = await transport.receive(maxMessages);
      if (this.stopped) return [];
      for (const message of messages) this.routes.set(message.id, transport);
      return messages;
    } finally {
      this.release(transport);
    }
  }
  async ack(message: RocketMqMessage): Promise<void> {
    const transport = await this.acquireRouteOrCurrent(message.id);
    try {
      await this.settle(transport, message, 'ack');
      this.routes.delete(message.id);
    } finally {
      this.release(transport);
    }
  }
  async nack(message: RocketMqMessage): Promise<void> {
    const transport = await this.acquireRouteOrCurrent(message.id);
    try {
      await this.settle(transport, message, 'nack');
      this.routes.delete(message.id);
    } finally {
      this.release(transport);
    }
  }
  async publishDlq(message: RocketMqMessage, reason: string): Promise<void> {
    const transport = await this.acquireRouteOrCurrent(message.id);
    try {
      await transport.publishDlq(message, reason);
    } finally {
      this.release(transport);
    }
  }
  async ping(): Promise<void> {
    const transport = await this.acquireCurrent();
    try {
      await transport.ping();
    } finally {
      this.release(transport);
    }
  }
  async stopPulling(): Promise<void> {
    this.pulling = false;
    await Promise.allSettled([...this.allTransports()].map((transport) => transport.stopPulling()));
  }
  async stop(): Promise<void> {
    this.stopInFlight ??= this.stopInternal();
    return this.stopInFlight;
  }

  private async stopInternal(): Promise<void> {
    this.stopped = true;
    await this.stopPulling();
    const refresh = this.refreshInFlight;
    if (refresh !== null)
      await bounded(
        refresh.catch(() => undefined),
        this.input.stopDrainTimeoutMs ?? 10_000,
      );
    const transports = this.allTransports();
    const drained = await bounded(
      Promise.all([...transports].map((transport) => this.waitForDrain(transport))),
      this.input.stopDrainTimeoutMs ?? 10_000,
    );
    if (!drained) this.forceReleaseRoutes();
    await Promise.allSettled([...transports].map((transport) => this.stopTransport(transport)));
    await Promise.allSettled([...this.retirementTasks]);
    this.current = null;
    this.retired.clear();
    this.routes.clear();
  }

  private async ensureCurrent(): Promise<RocketMqTransport> {
    if (this.stopped) throw new Error('BROKER_STOPPED');
    const now = (this.input.now ?? (() => new Date()))();
    if (
      this.current !== null &&
      this.current.expiresAt.getTime() - (this.input.refreshBeforeMs ?? 5 * 60_000) > now.getTime()
    )
      return this.current.transport;
    const refresh = (this.refreshInFlight ??= this.rotate());
    try {
      return await refresh;
    } finally {
      if (this.refreshInFlight === refresh) this.refreshInFlight = null;
    }
  }

  private async rotate(): Promise<RocketMqTransport> {
    const credentials = await this.input.credentials();
    const now = (this.input.now ?? (() => new Date()))();
    if (!Number.isFinite(credentials.expiresAt.getTime()) || credentials.expiresAt <= now)
      throw new Error('STS_CREDENTIALS_EXPIRED');
    const sessionId = credentialIdentity(credentials.value, credentials.expiresAt);
    if (this.current?.sessionId === sessionId) return this.current.transport;
    const replacement = this.input.create(credentials.value);
    if (this.isStopped()) {
      await replacement.stopPulling();
      await this.stopTransport(replacement);
      throw new Error('BROKER_STOPPED');
    }
    try {
      await replacement.start();
    } catch (error) {
      await this.stopTransport(replacement);
      throw error;
    }
    if (this.isStopped()) {
      await replacement.stopPulling();
      await this.stopTransport(replacement);
      throw new Error('BROKER_STOPPED');
    }
    if (!this.pulling) await replacement.stopPulling();
    const previous = this.current?.transport;
    this.current = { transport: replacement, expiresAt: credentials.expiresAt, sessionId };
    if (previous !== undefined) {
      this.retired.add(previous);
      await previous.stopPulling();
      const retirement = this.retireWhenDrained(previous);
      const tracked = retirement.then(
        () => {
          this.retirementTasks.delete(tracked);
        },
        (error: unknown) => {
          this.retirementTasks.delete(tracked);
          this.report(this.input.onRetirementError, error);
        },
      );
      this.retirementTasks.add(tracked);
    }
    return replacement;
  }

  private async acquireCurrent(): Promise<RocketMqTransport> {
    const transport = await this.ensureCurrent();
    if (this.stopped) throw new Error('BROKER_STOPPED');
    this.retain(transport);
    return transport;
  }

  private async acquireRouteOrCurrent(messageId: string): Promise<RocketMqTransport> {
    const routed = this.routes.get(messageId);
    if (routed !== undefined) {
      this.retain(routed);
      return routed;
    }
    return this.acquireCurrent();
  }

  private retain(transport: RocketMqTransport): void {
    this.activeOperations.set(transport, (this.activeOperations.get(transport) ?? 0) + 1);
  }

  private release(transport: RocketMqTransport): void {
    const remaining = (this.activeOperations.get(transport) ?? 1) - 1;
    if (remaining > 0) this.activeOperations.set(transport, remaining);
    else this.activeOperations.delete(transport);
    this.notifyDrained(transport);
  }

  private isDrained(transport: RocketMqTransport): boolean {
    return (
      (this.activeOperations.get(transport) ?? 0) === 0 &&
      ![...this.routes.values()].includes(transport)
    );
  }

  private notifyDrained(transport: RocketMqTransport): void {
    if (!this.isDrained(transport)) return;
    for (const resolve of this.drainWaiters.get(transport) ?? []) resolve();
    this.drainWaiters.delete(transport);
  }

  private waitForDrain(transport: RocketMqTransport): Promise<void> {
    if (this.isDrained(transport)) return Promise.resolve();
    return new Promise((resolve) => {
      const waiters = this.drainWaiters.get(transport) ?? new Set<() => void>();
      waiters.add(resolve);
      this.drainWaiters.set(transport, waiters);
    });
  }

  private async retireWhenDrained(transport: RocketMqTransport): Promise<void> {
    await this.waitForDrain(transport);
    if (!this.retired.delete(transport)) return;
    await this.stopTransport(transport);
  }

  private async stopTransport(transport: RocketMqTransport): Promise<void> {
    if (this.stoppedTransports.has(transport)) return;
    this.stoppedTransports.add(transport);
    await transport.stop();
  }

  private async settle(
    transport: RocketMqTransport,
    message: RocketMqMessage,
    operation: 'ack' | 'nack',
  ): Promise<void> {
    const failure = await this.retrySettlement(() => transport[operation](message));
    if (failure === null) return;
    if (operation === 'ack') await this.retrySettlement(() => transport.nack(message));
    this.report(this.input.onSettlementError, failure.error);
  }

  private async retrySettlement(
    operation: () => Promise<void>,
  ): Promise<{ error: unknown } | null> {
    const attempts = Math.max(1, this.input.settlementAttempts ?? 3);
    let failure: unknown = new Error('BROKER_SETTLEMENT_FAILED');
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        await operation();
        return null;
      } catch (error) {
        failure = error;
        if (attempt + 1 < attempts) await delay(this.input.settlementRetryMs ?? 100);
      }
    }
    return { error: failure };
  }

  private forceReleaseRoutes(): void {
    this.routes.clear();
    this.activeOperations.clear();
    for (const waiters of this.drainWaiters.values()) for (const resolve of waiters) resolve();
    this.drainWaiters.clear();
  }

  private report(callback: ((error: unknown) => void) | undefined, error: unknown): void {
    try {
      callback?.(error);
    } catch {
      // Observability callbacks cannot destabilize receipt settlement or graceful shutdown.
    }
  }

  private allTransports(): Set<RocketMqTransport> {
    const result = new Set(this.retired);
    if (this.current !== null) result.add(this.current.transport);
    return result;
  }

  private isStopped(): boolean {
    return this.stopped;
  }
}

function credentialIdentity(value: SessionCredentials, expiresAt: Date): string {
  return `${value.accessKey}\0${value.securityToken ?? ''}\0${expiresAt.toISOString()}`;
}

export class RocketMqNotificationConsumer {
  private running = false;
  private loop: Promise<void> = Promise.resolve();
  private inFlight = 0;
  maxObservedInFlight = 0;

  constructor(
    private readonly input: {
      transport: RocketMqTransport;
      handler(value: unknown): Promise<void>;
      metrics: Pick<NotificationMetrics, 'observeConsumerLag'>;
      maxInFlight?: number;
      maxDeliveryAttempts?: number;
      pollIntervalMs?: number;
      onError?: (error: unknown) => void;
    },
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  connect(): Promise<void> {
    return this.input.transport.start();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.input.transport.stopPulling();
    await this.loop;
    await this.input.transport.stop();
  }

  private async run(): Promise<void> {
    await this.input.transport.start();
    while (this.running) {
      try {
        const messages = await this.input.transport.receive(this.input.maxInFlight ?? 8);
        if (messages.length === 0) {
          await delay(this.input.pollIntervalMs ?? 250);
          continue;
        }
        await runBounded(messages, this.input.maxInFlight ?? 8, (message) => this.process(message));
      } catch (error) {
        this.input.onError?.(error);
        if (this.shouldContinue()) await delay(this.input.pollIntervalMs ?? 250);
      }
    }
  }

  private shouldContinue(): boolean {
    return this.running;
  }

  private async process(message: RocketMqMessage): Promise<void> {
    this.inFlight += 1;
    this.maxObservedInFlight = Math.max(this.maxObservedInFlight, this.inFlight);
    this.input.metrics.observeConsumerLag(Math.max(0, Date.now() - message.bornAt));
    try {
      let envelope: unknown;
      try {
        envelope = JSON.parse(Buffer.from(message.body).toString('utf8')) as unknown;
      } catch {
        await this.deadLetter(message, 'INVALID_JSON');
        return;
      }
      try {
        await this.input.handler(envelope);
        await this.input.transport.ack(message);
      } catch (error) {
        if (retryable(error) && message.deliveryAttempts < (this.input.maxDeliveryAttempts ?? 16)) {
          await this.input.transport.nack(message);
        } else {
          await this.deadLetter(message, safeReason(error));
        }
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private async deadLetter(message: RocketMqMessage, reason: string): Promise<void> {
    await this.input.transport.publishDlq(message, reason);
    await this.input.transport.ack(message);
  }
}

async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift() as T;
        await worker(item);
      }
    }),
  );
}

function retryable(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true
  );
}

function safeReason(error: unknown): string {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return /^[A-Z0-9_]{1,64}$/.test(error.code) ? error.code : 'PROCESSING_FAILED';
  }
  return 'PROCESSING_FAILED';
}

async function bounded(promise: Promise<unknown>, milliseconds: number): Promise<boolean> {
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    delay(milliseconds).then(() => false),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
