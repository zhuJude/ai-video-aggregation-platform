/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await -- concise test doubles intentionally model async ports and races. */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  NotificationMetrics,
  NotificationReadiness,
  startNotificationService,
} from '../src/runtime/production.js';
import {
  ApacheRocketMqTransport,
  RefreshingRocketMqTransport,
  RocketMqNotificationConsumer,
  uniqueHealthConsumerGroup,
} from '../src/adapters/rocketmq.consumer.js';

describe('notification production runtime', () => {
  it('checks DB, KMS, RAM, SMS and broker configuration and connectivity with a timeout', async () => {
    const readiness = new NotificationReadiness({
      database: { ping: () => Promise.resolve() },
      kms: { ping: () => Promise.resolve() },
      ram: { ping: () => Promise.resolve() },
      auth: { ping: () => Promise.resolve() },
      sms: { ping: () => Promise.resolve() },
      broker: { ping: () => Promise.resolve() },
      config: {
        kmsPhoneKey: 'kms://notification/phone',
        ramRoleArn: 'acs:ram::123:role/notification',
        smsRegion: 'cn-shanghai',
        brokerEndpoints: 'rmq-vpc:8081',
        consumerGroup: 'notification-v1',
        topic: 'domain-events',
      },
      timeoutMs: 20,
    });
    await expect(readiness.check()).resolves.toMatchObject({ database: 'ok', broker: 'ok' });
    await expect(
      new NotificationReadiness({
        ...readiness.dependencies,
        broker: { ping: () => new Promise(() => undefined) },
        timeoutMs: 5,
      }).check(),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('acks successful envelopes, nacks transient failures and publishes permanent failures to DLQ', async () => {
    const messages = [
      { id: 'ok', body: Buffer.from('{"ok":true}'), deliveryAttempts: 1, bornAt: Date.now() - 10 },
      {
        id: 'retry',
        body: Buffer.from('{"retry":true}'),
        deliveryAttempts: 1,
        bornAt: Date.now() - 20,
      },
      { id: 'bad', body: Buffer.from('{'), deliveryAttempts: 5, bornAt: Date.now() - 30 },
    ];
    const transport = {
      start: vi.fn().mockResolvedValue(undefined),
      receive: vi.fn().mockResolvedValueOnce(messages).mockResolvedValue([]),
      ack: vi.fn().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
      publishDlq: vi.fn().mockResolvedValue(undefined),
      stopPulling: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue(undefined),
    };
    const handler = vi.fn(async (value: unknown) => {
      if ((value as { retry?: boolean }).retry)
        throw Object.assign(new Error('temporary'), { retryable: true });
    });
    const metrics = new NotificationMetrics({
      gauges: { operatorQueue: () => Promise.resolve(0), retryQueue: () => Promise.resolve(0) },
    });
    const consumer = new RocketMqNotificationConsumer({
      transport,
      handler,
      metrics,
      maxInFlight: 2,
      maxDeliveryAttempts: 5,
      pollIntervalMs: 1,
    });
    consumer.start();
    await vi.waitFor(() => expect(transport.ack).toHaveBeenCalledWith(messages[0]));
    await vi.waitFor(() => expect(transport.nack).toHaveBeenCalledWith(messages[1]));
    await vi.waitFor(() =>
      expect(transport.publishDlq).toHaveBeenCalledWith(messages[2], 'INVALID_JSON'),
    );
    await consumer.stop();
    expect(transport.stop).toHaveBeenCalledOnce();
    expect(consumer.maxObservedInFlight).toBeLessThanOrEqual(2);
  });

  it('stops pulls, drains an accepted delivery, then shuts down the broker client', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const message = {
      id: 'accepted',
      body: Buffer.from('{}'),
      deliveryAttempts: 1,
      bornAt: Date.now(),
    };
    const transport = {
      start: vi.fn().mockResolvedValue(undefined),
      receive: vi.fn().mockResolvedValueOnce([message]).mockResolvedValue([]),
      ack: vi.fn().mockResolvedValue(undefined),
      nack: vi.fn().mockResolvedValue(undefined),
      publishDlq: vi.fn().mockResolvedValue(undefined),
      stopPulling: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue(undefined),
    };
    const consumer = new RocketMqNotificationConsumer({
      transport,
      handler: () => blocked,
      metrics: new NotificationMetrics({
        gauges: { operatorQueue: () => Promise.resolve(0), retryQueue: () => Promise.resolve(0) },
      }),
      pollIntervalMs: 1,
    });
    consumer.start();
    await vi.waitFor(() => expect(transport.receive).toHaveBeenCalled());
    const stopping = consumer.stop();
    await vi.waitFor(() => expect(transport.stopPulling).toHaveBeenCalledOnce());
    expect(transport.stop).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(transport.ack).toHaveBeenCalledWith(message);
    expect(transport.stop).toHaveBeenCalledOnce();
    const ackOrder = transport.ack.mock.invocationCallOrder[0];
    const stopOrder = transport.stop.mock.invocationCallOrder[0];
    expect(ackOrder).toBeDefined();
    expect(stopOrder).toBeDefined();
    expect(ackOrder as number).toBeLessThan(stopOrder as number);
  });

  it('subscribes only to supported notification event tags', async () => {
    const source = await readFile(
      resolve(import.meta.dirname, '../src/adapters/rocketmq.consumer.ts'),
      'utf8',
    );
    expect(source).toContain('task.succeeded.v1 || task.failed.v1');
    expect(source).not.toContain("new Map([[config.topic, '*']])");
  });

  it('uses a unique bounded health consumer group for every pod instance', () => {
    const first = uniqueHealthConsumerGroup('notification-v1', 'pod-a', '11111111');
    const second = uniqueHealthConsumerGroup('notification-v1', 'pod-b', '22222222');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    const longBase = 'x'.repeat(64);
    expect(uniqueHealthConsumerGroup(longBase, 'pod-a', 'same')).not.toBe(
      uniqueHealthConsumerGroup(longBase, 'pod-b', 'same'),
    );
  });

  it.each(['consumer', 'healthConsumer', 'dlqProducer'] as const)(
    'cleans every RocketMQ client when %s startup fails and preserves the cause',
    async (failed) => {
      const startupError = new Error(`${failed}_START_FAILED`);
      const clients = {
        consumer: lifecycleClient(failed === 'consumer' ? startupError : undefined),
        healthConsumer: lifecycleClient(failed === 'healthConsumer' ? startupError : undefined),
        dlqProducer: lifecycleClient(failed === 'dlqProducer' ? startupError : undefined),
      };
      const transport = new ApacheRocketMqTransport({
        endpoints: 'localhost:8081',
        namespace: '',
        consumerGroup: 'notification',
        topic: 'events',
        dlqTopic: 'events-dlq',
        healthTopic: 'health',
        healthConsumerGroup: 'notification-health',
        clients: clients as never,
      });
      await expect(transport.start()).rejects.toBe(startupError);
      await transport.stop();
      await transport.stop();
      expect(clients.consumer.shutdown).toHaveBeenCalledOnce();
      expect(clients.healthConsumer.shutdown).toHaveBeenCalledOnce();
      expect(clients.dlqProducer.shutdown).toHaveBeenCalledOnce();
    },
  );

  it('serializes start with stop and never resumes pulling after shutdown begins', async () => {
    let releaseStartup!: () => void;
    const pendingStartup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const clients = {
      consumer: lifecycleClient(),
      healthConsumer: lifecycleClient(),
      dlqProducer: lifecycleClient(),
    };
    clients.consumer.startup.mockReturnValueOnce(pendingStartup);
    const transport = new ApacheRocketMqTransport({
      endpoints: 'localhost:8081',
      namespace: '',
      consumerGroup: 'notification',
      topic: 'events',
      dlqTopic: 'events-dlq',
      healthTopic: 'health',
      healthConsumerGroup: 'notification-health',
      clients: clients as never,
    });
    const starting = transport.start();
    await vi.waitFor(() => expect(clients.consumer.startup).toHaveBeenCalledOnce());
    const stopping = transport.stop();
    releaseStartup();
    await expect(starting).rejects.toThrow('BROKER_STOPPED');
    await stopping;
    await expect(transport.start()).rejects.toThrow('BROKER_STOPPED');
    await expect(transport.receive(1)).resolves.toEqual([]);
    expect(clients.consumer.shutdown).toHaveBeenCalledOnce();
    expect(clients.healthConsumer.shutdown).toHaveBeenCalledOnce();
    expect(clients.dlqProducer.shutdown).toHaveBeenCalledOnce();
  });

  it('single-flight refreshes expiring RocketMQ STS clients and drains the old client', async () => {
    let clock = new Date('2026-09-14T00:00:00.000Z');
    const transports = [fakeTransport(), fakeTransport()];
    let created = 0;
    const credentials = vi.fn(async () => ({
      value: { accessKey: `id-${String(created)}`, accessSecret: 'secret', securityToken: 'token' },
      expiresAt: new Date(clock.getTime() + 1_000),
    }));
    const rotating = new RefreshingRocketMqTransport({
      credentials,
      create: () => transports[created++] as never,
      now: () => clock,
      refreshBeforeMs: 100,
    });
    await rotating.start();
    clock = new Date(clock.getTime() + 950);
    await Promise.all([rotating.ping(), rotating.ping()]);
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(transports[0]?.stopPulling).toHaveBeenCalledOnce();
    expect(transports[0]?.stop).toHaveBeenCalledOnce();
    await rotating.stop();
  });

  it('does not rotate to an unchanged STS session or extend it past SDK expiration', async () => {
    let clock = new Date('2026-09-14T00:00:00.000Z');
    const expiresAt = new Date(clock.getTime() + 1_000);
    const transport = fakeTransport();
    const create = vi.fn(() => transport as never);
    const rotating = new RefreshingRocketMqTransport({
      credentials: async () => ({
        value: { accessKey: 'id', accessSecret: 'secret', securityToken: 'token' },
        expiresAt,
      }),
      create,
      now: () => clock,
      refreshBeforeMs: 100,
    });
    await rotating.start();
    clock = new Date(clock.getTime() + 950);
    await rotating.ping();
    expect(create).toHaveBeenCalledOnce();
    clock = new Date(expiresAt.getTime() + 1);
    await expect(rotating.ping()).rejects.toThrow('STS_CREDENTIALS_EXPIRED');
    await rotating.stop();
  });

  it('stops a transport whose replacement startup fails and keeps the active transport', async () => {
    let clock = new Date('2026-09-14T00:00:00.000Z');
    const transports = [fakeTransport(), fakeTransport()];
    transports[1]!.start.mockRejectedValueOnce(new Error('START_FAILED'));
    let created = 0;
    const rotating = new RefreshingRocketMqTransport({
      credentials: async () => ({
        value: {
          accessKey: `id-${String(created)}`,
          accessSecret: 'secret',
          securityToken: 'token',
        },
        expiresAt: new Date(clock.getTime() + 1_000),
      }),
      create: () => transports[created++] as never,
      now: () => clock,
      refreshBeforeMs: 100,
    });
    await rotating.start();
    clock = new Date(clock.getTime() + 950);
    await expect(rotating.ping()).rejects.toThrow('START_FAILED');
    expect(transports[1]!.stop).toHaveBeenCalledOnce();
    expect(transports[0]!.stop).not.toHaveBeenCalled();
    await rotating.stop();
  });

  it('keeps an old client alive until a pending receive is routed and acknowledged after rotation', async () => {
    let clock = new Date('2026-09-14T00:00:00.000Z');
    let releaseReceive!: (messages: ReturnType<typeof message>[]) => void;
    const pendingReceive = new Promise<ReturnType<typeof message>[]>((resolve) => {
      releaseReceive = resolve;
    });
    const transports = [fakeTransport(), fakeTransport()];
    transports[0]!.receive.mockReturnValueOnce(pendingReceive);
    let created = 0;
    const rotating = new RefreshingRocketMqTransport({
      credentials: async () => ({
        value: { accessKey: 'id', accessSecret: 'secret', securityToken: 'token' },
        expiresAt: new Date(clock.getTime() + 1_000),
      }),
      create: () => transports[created++] as never,
      now: () => clock,
      refreshBeforeMs: 100,
    });
    await rotating.start();
    const receiving = rotating.receive(1);
    await vi.waitFor(() => expect(transports[0]!.receive).toHaveBeenCalledOnce());
    clock = new Date(clock.getTime() + 950);
    await rotating.ping();
    expect(transports[0]!.stop).not.toHaveBeenCalled();
    const accepted = message('accepted');
    releaseReceive([accepted]);
    await expect(receiving).resolves.toEqual([accepted]);
    expect(transports[0]!.stop).not.toHaveBeenCalled();
    await rotating.ack(accepted);
    await vi.waitFor(() => expect(transports[0]!.stop).toHaveBeenCalledOnce());
    await rotating.stop();
  });

  it('locks stop against a pending credential refresh and fully stops a late replacement', async () => {
    let resolveCredentials!: (value: {
      value: { accessKey: string; accessSecret: string; securityToken: string };
      expiresAt: Date;
    }) => void;
    const pending = new Promise<{
      value: { accessKey: string; accessSecret: string; securityToken: string };
      expiresAt: Date;
    }>((resolve) => {
      resolveCredentials = resolve;
    });
    const replacement = fakeTransport();
    const rotating = new RefreshingRocketMqTransport({
      credentials: () => pending,
      create: () => replacement as never,
    });
    const starting = rotating.start();
    const stopping = rotating.stop();
    resolveCredentials({
      value: { accessKey: 'id', accessSecret: 'secret', securityToken: 'token' },
      expiresAt: new Date(Date.now() + 60_000),
    });
    await expect(starting).rejects.toThrow('BROKER_STOPPED');
    await stopping;
    expect(replacement.stopPulling).toHaveBeenCalledOnce();
    expect(replacement.stop).toHaveBeenCalledOnce();
  });

  it('handles retired transport stop rejection without an unhandled rejection', async () => {
    let clock = new Date('2026-09-14T00:00:00.000Z');
    const transports = [fakeTransport(), fakeTransport()];
    transports[0]!.stop.mockRejectedValueOnce(new Error('RETIRE_FAILED'));
    let created = 0;
    const onRetirementError = vi.fn();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const rotating = new RefreshingRocketMqTransport({
        credentials: async () => ({
          value: { accessKey: 'id', accessSecret: 'secret', securityToken: 'token' },
          expiresAt: new Date(clock.getTime() + 1_000),
        }),
        create: () => transports[created++] as never,
        now: () => clock,
        refreshBeforeMs: 100,
        onRetirementError,
      });
      await rotating.start();
      clock = new Date(clock.getTime() + 950);
      await rotating.ping();
      await vi.waitFor(() => expect(onRetirementError).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await rotating.stop();
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('bounds failed ack/nack settlement and stop drain while stopping the old transport once', async () => {
    let clock = new Date('2026-09-14T00:00:00.000Z');
    const accepted = [message('ack'), message('nack'), message('receipt-expiry')];
    const transports = [fakeTransport(), fakeTransport()];
    transports[0]!.receive.mockResolvedValueOnce(accepted);
    transports[0]!.ack.mockRejectedValue(new Error('ACK_UNAVAILABLE'));
    transports[0]!.nack.mockRejectedValue(new Error('NACK_UNAVAILABLE'));
    let created = 0;
    const settlementErrors: unknown[] = [];
    const rotating = new RefreshingRocketMqTransport({
      credentials: async () => ({
        value: { accessKey: 'id', accessSecret: 'secret', securityToken: 'token' },
        expiresAt: new Date(clock.getTime() + 1_000),
      }),
      create: () => transports[created++] as never,
      now: () => clock,
      refreshBeforeMs: 100,
      settlementAttempts: 2,
      settlementRetryMs: 1,
      stopDrainTimeoutMs: 10,
      onSettlementError: (error) => settlementErrors.push(error),
    });
    await rotating.start();
    await rotating.receive(3);
    clock = new Date(clock.getTime() + 950);
    await rotating.ping();
    await expect(rotating.ack(accepted[0]!)).resolves.toBeUndefined();
    await expect(rotating.nack(accepted[1]!)).resolves.toBeUndefined();
    await expect(rotating.stop()).resolves.toBeUndefined();
    expect(settlementErrors).toHaveLength(2);
    expect(transports[0]!.stop).toHaveBeenCalledOnce();
  });

  it('connects and always closes the broker when business workers are disabled', async () => {
    const eventConsumer = {
      connect: vi.fn().mockResolvedValue(undefined),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    };
    const deliveryWorkers = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined) };
    const runtime = await startNotificationService({
      http: { handle: () => Promise.resolve({ status: 404, headers: {}, body: {} }) } as never,
      readiness: new NotificationReadiness({
        database: { ping: () => Promise.resolve() },
        kms: { ping: () => Promise.resolve() },
        ram: { ping: () => Promise.resolve() },
        auth: { ping: () => Promise.resolve() },
        sms: { ping: () => Promise.resolve() },
        broker: { ping: () => Promise.resolve() },
        config: {
          kmsPhoneKey: 'kms://phone',
          ramRoleArn: 'acs:ram::123:role/notification',
          smsRegion: 'cn-shanghai',
          brokerEndpoints: 'rmq:8081',
          consumerGroup: 'notification',
          topic: 'events',
        },
      }),
      metrics: new NotificationMetrics({
        gauges: { operatorQueue: () => Promise.resolve(0), retryQueue: () => Promise.resolve(0) },
      }),
      deliveryWorkers: deliveryWorkers as never,
      eventConsumer: eventConsumer as never,
      workersEnabled: false,
    });
    await runtime.close();
    expect(eventConsumer.connect).toHaveBeenCalledOnce();
    expect(eventConsumer.start).not.toHaveBeenCalled();
    expect(eventConsumer.stop).toHaveBeenCalledOnce();
    expect(deliveryWorkers.start).not.toHaveBeenCalled();
    expect(deliveryWorkers.stop).not.toHaveBeenCalled();
  });

  it('exports SMS retry/operator queue/consumer lag without phone or entity identifiers', async () => {
    const metrics = new NotificationMetrics({
      gauges: { operatorQueue: () => Promise.resolve(3), retryQueue: () => Promise.resolve(4) },
    });
    metrics.smsRetry('transient');
    metrics.observeConsumerLag(1_250);
    const output = await metrics.render();
    expect(output).toContain('support_notification_sms_retries_total{reason="transient"} 1');
    expect(output).toContain('support_notification_operator_queue 3');
    expect(output).toContain('support_notification_consumer_lag_seconds 1.25');
    expect(output).not.toMatch(/phone|user[_ ]?id|ticket[_ ]?id|notification[_ ]?id/i);
  });

  it('ships a non-root multi-stage image with the production start contract', async () => {
    const dockerfile = await readFile(resolve(import.meta.dirname, '../Dockerfile'), 'utf8');
    const packageJson = JSON.parse(
      await readFile(resolve(import.meta.dirname, '../package.json'), 'utf8'),
    ) as { scripts: Record<string, string> };
    expect(dockerfile.match(/^FROM /gm)?.length).toBeGreaterThanOrEqual(3);
    expect(dockerfile).toContain('pnpm install --lockfile=false --ignore-scripts');
    expect(dockerfile).not.toMatch(/--offline|--frozen-lockfile/);
    expect(dockerfile).not.toContain('COPY . .');
    expect(dockerfile).toContain('deploy --legacy --prod');
    expect(dockerfile).not.toMatch(
      /^COPY services\/notification-service services\/notification-service$/m,
    );
    expect(dockerfile).not.toMatch(
      /COPY .*\.(?:env|log)|COPY .*node_modules|COPY .*coverage|COPY services\/notification-service\/dist/i,
    );
    expect(dockerfile).toContain('prisma-generate.mjs');
    expect(dockerfile).not.toContain('DATABASE_URL=');
    expect(dockerfile).not.toContain('COPY packages/contracts packages/contracts');
    expect(dockerfile).toContain('COPY packages/contracts/src packages/contracts/src');
    expect(dockerfile).toContain(
      'COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json',
    );
    expect(dockerfile).toMatch(/^USER \d+$/m);
    expect(dockerfile).toContain('/health/ready');
    expect(dockerfile).not.toMatch(/(ACCESS_KEY_SECRET|SECRET_ACCESS_KEY|BEGIN PRIVATE KEY)\s*=/i);
    expect(packageJson.scripts.start).toBe('node dist/src/main.js');
    expect(packageJson.scripts.build).toBe(
      'node scripts/prisma-generate.mjs && tsc -p tsconfig.json',
    );
    expect(packageJson.scripts.typecheck).toBe(
      'node scripts/prisma-generate.mjs && tsc -p tsconfig.json --noEmit',
    );
    expect(packageJson.scripts.lint).toBe(
      'node scripts/prisma-generate.mjs && eslint src test prisma.config.ts',
    );
    const prismaGenerate = await readFile(
      resolve(import.meta.dirname, '../scripts/prisma-generate.mjs'),
      'utf8',
    );
    expect(prismaGenerate).toContain('postgresql://prisma-generate@127.0.0.1:5432/prisma-generate');
    expect(prismaGenerate).toContain('process.execPath');
    await expect(
      readFile(resolve(import.meta.dirname, '../src/main.ts'), 'utf8'),
    ).resolves.toContain('startNotificationService');
  });
});

function fakeTransport() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    receive: vi.fn().mockResolvedValue([]),
    ack: vi.fn().mockResolvedValue(undefined),
    nack: vi.fn().mockResolvedValue(undefined),
    publishDlq: vi.fn().mockResolvedValue(undefined),
    ping: vi.fn().mockResolvedValue(undefined),
    stopPulling: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function lifecycleClient(startupError?: Error) {
  return {
    startup: vi.fn(() =>
      startupError === undefined ? Promise.resolve() : Promise.reject(startupError),
    ),
    shutdown: vi.fn().mockResolvedValue(undefined),
    receive: vi.fn().mockResolvedValue([]),
    ack: vi.fn().mockResolvedValue(undefined),
    changeInvisibleDuration: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function message(id: string) {
  return { id, body: Buffer.from('{}'), deliveryAttempts: 1, bornAt: Date.now() };
}
