/* eslint-disable @typescript-eslint/no-confusing-void-expression, @typescript-eslint/no-non-null-assertion, @typescript-eslint/require-await -- deferred test doubles intentionally expose precise races. */
import { describe, expect, it, vi } from 'vitest';
import { RefreshingRocketMqProducer } from '../src/adapters/refreshing-rocketmq.producer.js';

describe('operations RocketMQ producer STS rotation', () => {
  it('single-flight refreshes before expiry and drains an in-flight send before retiring the old client', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const clients = [client(blocked), client()];
    let created = 0;
    const credentials = vi.fn(async () => credential(now));
    const producer = new RefreshingRocketMqProducer({
      credentials,
      create: () => clients[created++]! as never,
      now: () => now,
      refreshBeforeMs: 100,
    });
    await producer.startup();
    const oldSend = producer.send({ body: Buffer.from('old') } as never);
    await vi.waitFor(() => expect(clients[0]!.send).toHaveBeenCalled());
    now = new Date(now.getTime() + 950);
    await Promise.all([producer.send({} as never), producer.send({} as never)]);
    expect(credentials).toHaveBeenCalledTimes(2);
    expect(clients[0]!.shutdown).not.toHaveBeenCalled();
    release();
    await oldSend;
    await vi.waitFor(() => expect(clients[0]!.shutdown).toHaveBeenCalledOnce());
    await producer.shutdown();
  });

  it('keeps the active producer usable after refresh failure', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    const active = client();
    const credentials = vi
      .fn()
      .mockResolvedValueOnce(credential(now))
      .mockRejectedValueOnce(new Error('STS_UNAVAILABLE'));
    const producer = new RefreshingRocketMqProducer({
      credentials,
      create: () => active as never,
      now: () => now,
      refreshBeforeMs: 100,
    });
    await producer.startup();
    now = new Date(now.getTime() + 950);
    await expect(producer.send({} as never)).rejects.toThrow('STS_UNAVAILABLE');
    now = new Date('2026-09-14T00:00:00.000Z');
    await expect(producer.send({} as never)).resolves.toBeUndefined();
    expect(active.shutdown).not.toHaveBeenCalled();
    await producer.shutdown();
  });

  it('rejects an unchanged expired STS session without constructing a replacement', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    const clients = [client(), client()];
    const expiresAt = new Date(now.getTime() + 1_000);
    let created = 0;
    const producer = new RefreshingRocketMqProducer({
      credentials: async () => ({ ...credential(now), expiresAt }),
      create: () => clients[created++]! as never,
      now: () => now,
      refreshBeforeMs: 100,
    });
    await producer.startup();
    now = new Date(expiresAt.getTime() + 1);
    await expect(producer.send({} as never)).rejects.toThrow('STS_CREDENTIALS_EXPIRED');
    expect(clients).toHaveLength(2);
    expect(clients[1]!.startup).not.toHaveBeenCalled();
    await producer.shutdown();
  });

  it('shuts down a replacement whose startup fails without retiring the active producer', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    const clients = [client(), client()];
    clients[1]!.startup.mockRejectedValueOnce(new Error('START_FAILED'));
    let created = 0;
    const producer = new RefreshingRocketMqProducer({
      credentials: async () => credential(now),
      create: () => clients[created++]! as never,
      now: () => now,
      refreshBeforeMs: 100,
    });
    await producer.startup();
    now = new Date(now.getTime() + 950);
    await expect(producer.send({} as never)).rejects.toThrow('START_FAILED');
    expect(clients[1]!.shutdown).toHaveBeenCalledOnce();
    expect(clients[0]!.shutdown).not.toHaveBeenCalled();
    await producer.shutdown();
  });

  it('does not mask startup failure when replacement cleanup initially rejects', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    const clients = [client(), client()];
    const startupError = new Error('START_FAILED');
    clients[1]!.startup.mockRejectedValueOnce(startupError);
    clients[1]!.shutdown.mockRejectedValueOnce(new Error('CLEANUP_FAILED'));
    let created = 0;
    const producer = new RefreshingRocketMqProducer({
      credentials: async () => credential(now),
      create: () => clients[created++]! as never,
      now: () => now,
      refreshBeforeMs: 100,
    });
    await producer.startup();
    now = new Date(now.getTime() + 950);
    await expect(producer.send({} as never)).rejects.toBe(startupError);
    await producer.shutdown();
    expect(clients[1]!.shutdown).toHaveBeenCalledTimes(2);
  });

  it('waits for a pending refresh during shutdown and cannot leak the replacement', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    let resolveRefresh!: (value: ReturnType<typeof credential>) => void;
    const pending = new Promise<ReturnType<typeof credential>>(
      (resolve) => (resolveRefresh = resolve),
    );
    const clients = [client(), client()];
    let created = 0;
    const credentials = vi.fn().mockResolvedValueOnce(credential(now)).mockReturnValueOnce(pending);
    const producer = new RefreshingRocketMqProducer({
      credentials,
      create: () => clients[created++]! as never,
      now: () => now,
      refreshBeforeMs: 100,
    });
    await producer.startup();
    now = new Date(now.getTime() + 950);
    const sending = producer.send({} as never);
    await vi.waitFor(() => expect(credentials).toHaveBeenCalledTimes(2));
    const stopping = producer.shutdown();
    resolveRefresh(credential(now));
    await expect(sending).rejects.toThrow('BROKER_STOPPED');
    await stopping;
    expect(clients[1]!.shutdown).toHaveBeenCalledOnce();
  });

  it('preserves BROKER_STOPPED and retries cleanup when stop wins during credential refresh', async () => {
    let resolveCredentials!: (value: ReturnType<typeof credential>) => void;
    const pending = new Promise<ReturnType<typeof credential>>((resolve) => {
      resolveCredentials = resolve;
    });
    const replacement = client();
    replacement.shutdown.mockRejectedValueOnce(new Error('CLEANUP_FAILED'));
    const producer = new RefreshingRocketMqProducer({
      credentials: () => pending,
      create: () => replacement as never,
    });
    const starting = producer.startup();
    const stopping = producer.shutdown();
    resolveCredentials(credential(new Date()));
    await expect(starting).rejects.toThrow('BROKER_STOPPED');
    await stopping;
    expect(replacement.shutdown).toHaveBeenCalledTimes(2);
  });

  it('preserves BROKER_STOPPED and retries cleanup when stop wins during replacement startup', async () => {
    let releaseStartup!: () => void;
    const pendingStartup = new Promise<void>((resolve) => {
      releaseStartup = resolve;
    });
    const replacement = client();
    replacement.startup.mockReturnValueOnce(pendingStartup);
    replacement.shutdown.mockRejectedValueOnce(new Error('CLEANUP_FAILED'));
    const producer = new RefreshingRocketMqProducer({
      credentials: async () => credential(new Date()),
      create: () => replacement as never,
    });
    const starting = producer.startup();
    await vi.waitFor(() => expect(replacement.startup).toHaveBeenCalledOnce());
    const stopping = producer.shutdown();
    releaseStartup();
    await expect(starting).rejects.toThrow('BROKER_STOPPED');
    await stopping;
    expect(replacement.shutdown).toHaveBeenCalledTimes(2);
  });

  it('handles retirement shutdown rejection without an unhandled rejection', async () => {
    let now = new Date('2026-09-14T00:00:00.000Z');
    const clients = [client(), client()];
    clients[0]!.shutdown.mockRejectedValueOnce(new Error('RETIRE_FAILED'));
    let created = 0;
    const onRetirementError = vi.fn();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      const producer = new RefreshingRocketMqProducer({
        credentials: async () => credential(now),
        create: () => clients[created++]! as never,
        now: () => now,
        refreshBeforeMs: 100,
        onRetirementError,
      });
      await producer.startup();
      now = new Date(now.getTime() + 950);
      await producer.send({} as never);
      await vi.waitFor(() => expect(onRetirementError).toHaveBeenCalledOnce());
      await new Promise((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
      await producer.shutdown();
    } finally {
      process.off('unhandledRejection', listener);
    }
  });
});

function credential(now: Date) {
  return {
    value: { accessKey: 'id', accessSecret: 'secret', securityToken: 'token' },
    expiresAt: new Date(now.getTime() + 1_000),
  };
}
function client(send: Promise<void> = Promise.resolve()) {
  return {
    startup: vi.fn().mockResolvedValue(undefined),
    send: vi.fn(() => send),
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}
