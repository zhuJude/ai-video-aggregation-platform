import { describe, expect, it, vi } from 'vitest';
import { EventEnvelopeSchema } from '@repo/contracts/common';
import {
  InMemoryNotificationRepository,
  NotificationConsumer,
  NotificationService,
  NotificationWorker,
  TemplateService,
  computeBackoffDelay,
  NotificationWorkerRunner,
} from '../src/application/notification.consumer.js';
import type { SmsSender } from '../src/ports/sms-sender.js';

const USER = '01990f24-2ba2-7000-8000-000000000001';
const EVENT = '01990f24-2ba2-7000-8000-000000000002';
const CORRELATION = '01990f24-2ba2-7000-8000-000000000003';
const CAUSATION = '01990f24-2ba2-7000-8000-000000000004';
const NOW = new Date('2026-09-14T12:00:00.000Z');

function payload(type: string): Record<string, unknown> {
  const delivery = {
    userId: USER,
    phoneE164: '+8613800138000',
    templateKey: 'task-success',
    variables: { taskId: 'task-1' },
    channels: ['IN_APP', 'SMS'],
  };
  if (type.startsWith('task.'))
    return {
      taskId: CAUSATION,
      status: type.includes('succeeded') ? 'SUCCEEDED' : 'FAILED',
      ...delivery,
    };
  if (type.startsWith('payment.'))
    return {
      paymentId: CAUSATION,
      status: type.includes('succeeded') ? 'PAID' : 'FAILED',
      ...delivery,
    };
  if (type.startsWith('ticket.'))
    return { ticketId: CAUSATION, messageId: CORRELATION, ...delivery };
  return { walletId: CAUSATION, availablePoints: '10', ...delivery };
}

function envelope(overrides: Record<string, unknown> = {}) {
  const type = typeof overrides.type === 'string' ? overrides.type : 'task.succeeded.v1';
  return {
    id: EVENT,
    type,
    version: 1,
    occurredAt: NOW.toISOString(),
    traceId: 'a'.repeat(32),
    correlationId: CORRELATION,
    causationId: CAUSATION,
    producer: 'generation-service',
    data: payload(type),
    ...overrides,
  };
}

function setup(sender?: SmsSender) {
  let n = 10;
  const id = () => `01990f24-2ba2-7000-8000-${String(++n).padStart(12, '0')}`;
  const repository = new InMemoryNotificationRepository();
  let current = NOW;
  const now = () => current;
  const templates = new TemplateService(repository, id, now);
  const sms = sender ?? {
    send: vi
      .fn()
      .mockResolvedValue({ status: 'ACCEPTED' as const, requestId: 'req-1', receipt: 'accepted' }),
    reconcile: vi
      .fn()
      .mockResolvedValue({ status: 'DELIVERED', requestId: 'req-1', receipt: 'delivered' }),
  };
  const worker = new NotificationWorker(repository, sms, {
    id,
    now,
    maxAttempts: 4,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
  });
  const consumer = new NotificationConsumer(repository, templates, worker, { id, now });
  return {
    repository,
    templates,
    worker,
    consumer,
    sms,
    service: new NotificationService(repository, now),
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

async function publishDefault(templates: TemplateService) {
  return templates.publish({
    templateKey: 'task-success',
    declaredVariables: ['taskId'],
    inAppTitle: '任务完成',
    inAppBody: '任务 {{taskId}} 已完成',
    smsBody: '任务${taskId}已完成',
    smsSignName: '平台通知',
    smsTemplateCode: 'SMS_123456',
  });
}

describe('notification delivery', () => {
  it('caps exponential retry delay', () => {
    expect(computeBackoffDelay(1, 1_000, 8_000)).toBe(1_000);
    expect(computeBackoffDelay(20, 1_000, 8_000)).toBe(8_000);
  });
  it('sends one notification for a replayed event', async () => {
    const { consumer, templates, sms } = setup();
    await publishDefault(templates);
    await consumer.handle(envelope());
    await consumer.handle(envelope());
    expect(sms.send).toHaveBeenCalledTimes(1);
  });

  it('accepts a real frozen EventEnvelope and optional causationId', async () => {
    const { consumer, templates } = setup();
    await publishDefault(templates);
    const event = EventEnvelopeSchema.parse(envelope());
    await expect(consumer.handle(event)).resolves.toBeUndefined();
    await expect(
      consumer.handle({
        ...envelope({ id: '01990f24-2ba2-7000-8000-000000000090' }),
        causationId: undefined,
      }),
    ).resolves.toBeUndefined();
  });

  it.each([
    'task.failed.v1',
    'payment.succeeded.v1',
    'payment.failed.v1',
    'ticket.replied.v1',
    'wallet.low-balance.v1',
  ])('consumes supported %s envelopes', async (eventType) => {
    const { consumer, templates, repository } = setup();
    await publishDefault(templates);
    await consumer.handle(envelope({ type: eventType }));
    expect(await repository.countInboxMessages(USER)).toBe(1);
  });

  it('uses database uniqueness to deduplicate concurrent delivery', async () => {
    const { consumer, templates, sms, repository } = setup();
    await publishDefault(templates);
    await Promise.all(Array.from({ length: 20 }, () => consumer.handle(envelope())));
    expect(sms.send).toHaveBeenCalledTimes(1);
    expect(await repository.countInboxMessages(USER)).toBe(1);
  });

  it('rejects template variables not declared by the template', async () => {
    const { templates } = setup();
    await publishDefault(templates);
    await expect(
      templates.render('task-success', { taskId: '1', secret: 'leak' }, 'SMS'),
    ).rejects.toMatchObject({ code: 'UNKNOWN_TEMPLATE_VARIABLE' });
  });

  it('rejects missing variables and template injection syntax', async () => {
    const { templates } = setup();
    await publishDefault(templates);
    await expect(templates.render('task-success', {}, 'SMS')).rejects.toMatchObject({
      code: 'MISSING_TEMPLATE_VARIABLE',
    });
    await expect(
      templates.publish({
        templateKey: 'unsafe',
        declaredVariables: ['x'],
        inAppTitle: 'x',
        inAppBody: '{{constructor.constructor}}',
        smsBody: '${x}',
        smsSignName: '平台通知',
        smsTemplateCode: 'SMS_123456',
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_TEMPLATE' });
  });

  it.each([
    ['version', 0],
    ['occurredAt', '2026-09-14 12:00:00'],
    ['correlationId', '550e8400-e29b-41d4-a716-446655440000'],
    ['causationId', 'not-a-uuid'],
  ])('strictly rejects invalid envelope field %s', async (key, value) => {
    const { consumer, templates } = setup();
    await publishDefault(templates);
    await expect(consumer.handle(envelope({ [key]: value }))).rejects.toMatchObject({
      code: 'INVALID_EVENT_ENVELOPE',
    });
  });

  it('rejects unsupported event types and future contract versions', async () => {
    const { consumer, templates } = setup();
    await publishDefault(templates);
    await expect(consumer.handle(envelope({ type: 'unknown.event.v1' }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_EVENT_TYPE',
    });
    await expect(consumer.handle(envelope({ version: 2 }))).rejects.toMatchObject({
      code: 'UNSUPPORTED_CONTRACT_VERSION',
    });
  });

  it('rejects extra fields in each event payload and envelope', async () => {
    const { consumer, templates } = setup();
    await publishDefault(templates);
    for (const type of [
      'task.succeeded.v1',
      'payment.succeeded.v1',
      'ticket.replied.v1',
      'wallet.low-balance.v1',
    ]) {
      await expect(
        consumer.handle(envelope({ type, data: { ...payload(type), unexpected: true } })),
      ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    }
    await expect(consumer.handle({ ...envelope(), unexpected: true })).rejects.toMatchObject({
      code: 'INVALID_EVENT_ENVELOPE',
    });
  });

  it('uses frozen payment and points value domains', async () => {
    const { consumer, templates } = setup();
    await publishDefault(templates);
    await expect(
      consumer.handle(envelope({ type: 'payment.succeeded.v1' })),
    ).resolves.toBeUndefined();
    await expect(
      consumer.handle(
        envelope({
          id: '01990f24-2ba2-7000-8000-000000000081',
          type: 'payment.succeeded.v1',
          data: { ...payload('payment.succeeded.v1'), status: 'SUCCEEDED' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
    await expect(
      consumer.handle(
        envelope({
          id: '01990f24-2ba2-7000-8000-000000000082',
          type: 'wallet.low-balance.v1',
          data: { ...payload('wallet.low-balance.v1'), availablePoints: '0' },
        }),
      ),
    ).resolves.toBeUndefined();
    for (const [index, availablePoints] of ['-1', '01', '10.5'].entries())
      await expect(
        consumer.handle(
          envelope({
            id: `01990f24-2ba2-7000-8000-00000000008${String(index)}`,
            type: 'wallet.low-balance.v1',
            data: { ...payload('wallet.low-balance.v1'), availablePoints },
          }),
        ),
      ).rejects.toMatchObject({ code: 'INVALID_EVENT_PAYLOAD' });
  });

  it('deduplicates before resolving the latest template', async () => {
    const { consumer, templates } = setup();
    await publishDefault(templates);
    await consumer.handle(envelope());
    const render = vi.spyOn(templates, 'render');
    await consumer.handle(envelope());
    expect(render).not.toHaveBeenCalled();
  });

  it('reads one immutable template snapshot when both channels render', async () => {
    const { consumer, templates, repository } = setup();
    const v1 = await publishDefault(templates);
    const original = repository.latestTemplate.bind(repository);
    const latest = vi.spyOn(repository, 'latestTemplate').mockImplementation(async (key) => {
      const snapshot = await original(key);
      await templates.publish({
        templateKey: 'task-success',
        declaredVariables: ['taskId'],
        inAppTitle: 'v2 title',
        inAppBody: 'v2 body {{taskId}}',
        smsBody: 'v2 sms ${taskId}',
        smsSignName: 'v2 sign',
        smsTemplateCode: 'SMS_654321',
      });
      return snapshot;
    });
    await consumer.handle(envelope());
    expect(latest).toHaveBeenCalledTimes(1);
    const rows = await repository.listNotifications();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.templateVersionId === v1.id)).toBe(true);
    expect(rows.find((row) => row.channel === 'IN_APP')?.renderedBody).toContain('任务');
    expect(rows.find((row) => row.channel === 'SMS')?.renderedBody).toContain('任务');
  });

  it('pins the published template version, sign and code on delivery', async () => {
    const { consumer, templates, repository } = setup();
    const v1 = await publishDefault(templates);
    await templates.publish({
      templateKey: 'task-success',
      declaredVariables: ['taskId'],
      inAppTitle: '新标题',
      inAppBody: '新 {{taskId}}',
      smsBody: '新${taskId}',
      smsSignName: '新签名',
      smsTemplateCode: 'SMS_654321',
    });
    await consumer.handle(envelope());
    const notifications = await repository.listNotifications();
    expect(notifications.every((item) => item.templateVersionId !== v1.id)).toBe(true);
    expect(notifications.find((item) => item.channel === 'SMS')).toMatchObject({
      signName: '新签名',
      templateCode: 'SMS_654321',
    });
  });

  it('recovers accepted sends by receipt reconciliation without sending again', async () => {
    const sender = {
      send: vi.fn().mockResolvedValue({
        status: 'ACCEPTED' as const,
        requestId: 'req-accepted',
        receipt: 'accepted',
      }),
      reconcile: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'PENDING' as const,
          requestId: 'query-1',
          receipt: 'accepted',
        })
        .mockResolvedValueOnce({
          status: 'PENDING' as const,
          requestId: 'query-2',
          receipt: 'accepted',
        })
        .mockResolvedValueOnce({
          status: 'DELIVERED' as const,
          requestId: 'query-3',
          receipt: 'accepted',
        }),
    };
    const { consumer, templates, worker, repository, advance } = setup(sender);
    await publishDefault(templates);
    repository.failNextFinalize();
    await expect(consumer.handle(envelope())).rejects.toThrow('SIMULATED_DATABASE_FAILURE');
    advance(30_000);
    await worker.runOnce();
    advance(1_000);
    await worker.runOnce();
    advance(2_000);
    await worker.runOnce();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.reconcile).toHaveBeenCalledTimes(3);
    expect(
      (await repository.listNotifications()).find((item) => item.channel === 'SMS'),
    ).toMatchObject({ status: 'DELIVERED' });
  });

  it('caps pending receipt reconciliation attempts and queues operator review', async () => {
    const sender = {
      send: vi.fn().mockResolvedValue({
        status: 'ACCEPTED' as const,
        requestId: 'req-accepted',
        receipt: 'biz-accepted',
      }),
      reconcile: vi.fn().mockResolvedValue({
        status: 'PENDING' as const,
        requestId: 'query-pending',
        receipt: 'biz-accepted',
      }),
    };
    const { consumer, templates, worker, repository, advance } = setup(sender);
    await publishDefault(templates);
    await consumer.handle(envelope());
    for (const delay of [1_000, 1_000, 2_000, 4_000]) {
      advance(delay);
      await worker.runOnce();
    }
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.reconcile).toHaveBeenCalledTimes(4);
    expect(
      (await repository.listNotifications()).find((item) => item.channel === 'SMS'),
    ).toMatchObject({
      status: 'OPERATOR_REVIEW',
      reconciliationAttempts: 4,
    });
    expect(await repository.listOperatorQueue()).toHaveLength(1);
  });

  it('persists the reconciliation attempt before the external receipt query', async () => {
    let observedAttempts = -1;
    const sender = {
      send: vi.fn().mockResolvedValue({
        status: 'ACCEPTED' as const,
        requestId: 'req-accepted',
        receipt: 'biz-accepted',
      }),
      reconcile: vi.fn(),
    };
    const setupResult = setup(sender);
    sender.reconcile.mockImplementation(async () => {
      observedAttempts =
        (await setupResult.repository.listNotifications()).find((item) => item.channel === 'SMS')
          ?.reconciliationAttempts ?? -1;
      return { status: 'PENDING' as const, requestId: 'query-pending' };
    });
    await publishDefault(setupResult.templates);
    await setupResult.consumer.handle(envelope());
    setupResult.advance(1_000);
    await setupResult.worker.runOnce();
    expect(observedAttempts).toBe(1);
  });

  it('reconciles unknown send acceptance and never blindly sends again', async () => {
    const unknown = Object.assign(new Error('socket reset after write'), {
      kind: 'TRANSIENT' as const,
      code: 'NETWORK_RESPONSE_UNKNOWN',
    });
    const sender = {
      send: vi.fn().mockRejectedValue(unknown),
      reconcile: vi.fn().mockResolvedValue({
        status: 'PENDING' as const,
        requestId: 'query-1',
      }),
    };
    const { consumer, templates, worker, repository, advance } = setup(sender);
    await publishDefault(templates);
    await consumer.handle(envelope());
    expect(
      (await repository.listNotifications()).find((item) => item.channel === 'SMS'),
    ).toMatchObject({
      status: 'RECONCILING',
      providerReceiptStatus: 'UNKNOWN_ACCEPTANCE',
      sendStartedAt: NOW,
    });
    advance(1_000);
    await worker.runOnce();
    expect(sender.send).toHaveBeenCalledTimes(1);
    expect(sender.reconcile).toHaveBeenCalledTimes(1);
  });

  it('resends only after authoritative reconciliation confirms non-acceptance', async () => {
    const unknown = Object.assign(new Error('socket reset after write'), {
      kind: 'TRANSIENT' as const,
      code: 'NETWORK_RESPONSE_UNKNOWN',
    });
    const sender = {
      send: vi
        .fn()
        .mockRejectedValueOnce(unknown)
        .mockResolvedValueOnce({
          status: 'ACCEPTED' as const,
          requestId: 'req-2',
          receipt: 'biz-2',
        }),
      reconcile: vi.fn().mockResolvedValue({
        status: 'NOT_ACCEPTED' as const,
        requestId: 'query-authoritative',
      }),
    };
    const { consumer, templates, worker, repository, advance } = setup(sender);
    await publishDefault(templates);
    await consumer.handle(envelope());
    advance(1_000);
    await worker.runOnce();
    expect(sender.send).toHaveBeenCalledTimes(1);
    advance(1_000);
    await worker.runOnce();
    expect(sender.send).toHaveBeenCalledTimes(2);
    expect(
      (await repository.listNotifications()).find((item) => item.channel === 'SMS'),
    ).toMatchObject({
      providerReceiptStatus: 'ACCEPTED',
    });
  });

  it('periodically drains due work and stops gracefully', async () => {
    vi.useFakeTimers();
    try {
      const worker = { runOnce: vi.fn().mockResolvedValue(false) };
      const runner = new NotificationWorkerRunner(worker, { intervalMs: 100 });
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(worker.runOnce).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(worker.runOnce).toHaveBeenCalledTimes(2);
      await runner.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(500);
      expect(worker.runOnce).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds runner shutdown even when a worker call never settles', async () => {
    vi.useFakeTimers();
    try {
      const worker = { runOnce: vi.fn(() => new Promise<boolean>(() => undefined)) };
      const runner = new NotificationWorkerRunner(worker, { intervalMs: 100, stopTimeoutMs: 250 });
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      let stopped = false;
      void runner.stop().then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(249);
      expect(stopped).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(stopped).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('worker runner reconciles unknown acceptance without another event', async () => {
    vi.useFakeTimers();
    try {
      const transient = Object.assign(new Error('socket reset after request write'), {
        kind: 'TRANSIENT' as const,
        code: 'NETWORK_RESPONSE_UNKNOWN',
      });
      const sender = {
        send: vi.fn().mockRejectedValue(transient),
        reconcile: vi.fn().mockResolvedValue({
          status: 'DELIVERED' as const,
          requestId: 'query-delivered',
        }),
      };
      const { consumer, templates, worker, repository, advance } = setup(sender);
      await publishDefault(templates);
      await consumer.handle(envelope());
      advance(1_000);
      const runner = new NotificationWorkerRunner(worker, { intervalMs: 100 });
      runner.start();
      await vi.advanceTimersByTimeAsync(0);
      await runner.stop();
      expect(sender.send).toHaveBeenCalledTimes(1);
      expect(sender.reconcile).toHaveBeenCalledTimes(1);
      expect(
        (await repository.listNotifications()).find((item) => item.channel === 'SMS'),
      ).toMatchObject({ status: 'DELIVERED' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses capped exponential backoff and routes permanent errors to operators', async () => {
    const transient = Object.assign(new Error('credentials unavailable before request'), {
      kind: 'TRANSIENT' as const,
      code: 'RAM_CREDENTIAL_REFRESH_FAILED',
      acceptance: 'NOT_ATTEMPTED' as const,
    });
    const sender = { send: vi.fn().mockRejectedValue(transient), reconcile: vi.fn() };
    const { consumer, templates, repository } = setup(sender);
    await publishDefault(templates);
    await consumer.handle(envelope());
    expect(
      (await repository.listNotifications()).find((item) => item.channel === 'SMS'),
    ).toMatchObject({
      status: 'RETRY_PENDING',
      attempts: 1,
      nextAttemptAt: new Date(NOW.getTime() + 1_000),
    });

    const permanent = Object.assign(new Error('bad phone'), {
      kind: 'PERMANENT' as const,
      code: 'INVALID_PHONE',
      acceptance: 'NOT_ATTEMPTED' as const,
    });
    const second = setup({ send: vi.fn().mockRejectedValue(permanent), reconcile: vi.fn() });
    await publishDefault(second.templates);
    await second.consumer.handle(envelope());
    expect(await second.repository.listOperatorQueue()).toHaveLength(1);
  });

  it('records failure completion and retry schedule from the post-provider clock', async () => {
    const startedAt = new Date('2026-09-14T12:00:00.000Z');
    const failedAt = new Date('2026-09-14T12:00:07.000Z');
    const retry = vi.fn().mockResolvedValue(undefined);
    const repository = {
      claim: vi.fn().mockResolvedValue({
        id: EVENT,
        eventId: EVENT,
        userId: USER,
        channel: 'SMS',
        templateVersionId: CAUSATION,
        renderedTitle: null,
        renderedBody: 'sms',
        variables: {},
        phoneE164: '+8613800138000',
        signName: '平台通知',
        templateCode: 'SMS_123456',
        status: 'PENDING',
        attempts: 1,
        nextAttemptAt: startedAt,
        claimToken: CORRELATION,
        leaseUntil: new Date(startedAt.getTime() + 30_000),
        providerRequestId: null,
        providerReceipt: null,
        providerReceiptStatus: null,
        reconciliationAttempts: 0,
        sendStartedAt: startedAt,
        sendDate: '20260914',
        createdAt: startedAt,
        deliveryMode: 'SEND',
      }),
      retry,
    };
    const error = Object.assign(new Error('credentials unavailable'), {
      kind: 'TRANSIENT' as const,
      code: 'RAM_CREDENTIAL_REFRESH_FAILED',
      acceptance: 'NOT_ATTEMPTED' as const,
    });
    const worker = new NotificationWorker(
      repository as never,
      { send: vi.fn().mockRejectedValue(error), reconcile: vi.fn() },
      {
        id: () => CORRELATION,
        now: vi.fn().mockReturnValueOnce(startedAt).mockReturnValueOnce(failedAt),
        baseDelayMs: 1_000,
      },
    );
    await worker.runOnce();
    expect(retry).toHaveBeenCalledWith(
      EVENT,
      CORRELATION,
      new Date(failedAt.getTime() + 1_000),
      'RAM_CREDENTIAL_REFRESH_FAILED',
      failedAt,
    );
  });

  it('allows exactly maxAttempts provider calls before operator review', async () => {
    const notAttempted = Object.assign(new Error('credential refresh failed'), {
      kind: 'TRANSIENT' as const,
      code: 'RAM_CREDENTIAL_REFRESH_FAILED',
      acceptance: 'NOT_ATTEMPTED' as const,
    });
    const sender = { send: vi.fn().mockRejectedValue(notAttempted), reconcile: vi.fn() };
    const { consumer, templates, worker, repository, advance } = setup(sender);
    await publishDefault(templates);
    await consumer.handle(envelope());
    for (const delay of [1_000, 2_000, 4_000]) {
      advance(delay);
      await worker.runOnce();
    }
    expect(sender.send).toHaveBeenCalledTimes(4);
    expect(
      (await repository.listNotifications()).find((item) => item.channel === 'SMS'),
    ).toMatchObject({
      status: 'OPERATOR_REVIEW',
      attempts: 4,
    });
  });

  it('isolates inbox users, marks read idempotently, and paginates with a stable cursor', async () => {
    const { consumer, templates, service } = setup();
    await publishDefault(templates);
    await consumer.handle(envelope());
    const first = await service.listInbox(USER, { limit: 1 });
    expect(first.items).toHaveLength(1);
    const message = first.items[0];
    if (message === undefined) throw new Error('expected inbox message');
    expect(await service.listInbox('01990f24-2ba2-7000-8000-000000000099', { limit: 20 })).toEqual({
      items: [],
    });
    await service.markRead(USER, message.id);
    await service.markRead(USER, message.id);
    expect((await service.listInbox(USER, { limit: 1 })).items[0]?.readAt).toEqual(NOW);
    await expect(
      service.markRead('01990f24-2ba2-7000-8000-000000000099', message.id),
    ).rejects.toMatchObject({ code: 'INBOX_MESSAGE_NOT_FOUND' });
  });
});
