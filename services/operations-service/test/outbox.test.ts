import { describe, expect, it, vi } from 'vitest';
import { InMemoryOutboxStore, OperationsOutboxDispatcher } from '../src/adapters/operations-outbox.dispatcher.js';

const envelope = (type: string) => ({ id: '01990f24-2ba2-7000-8000-000000000010', type, version: 1,
  occurredAt: '2026-08-31T12:00:00.000Z', traceId: '0123456789abcdef0123456789abcdef',
  correlationId: '01990f24-2ba2-7000-8000-000000000011', producer: 'operations-service', data: {} });

describe('operations outbox dispatcher', () => {
  it('publishes a pending event once and makes replay a no-op', async () => {
    const event = envelope('operations.content.published.v1');
    const store = new InMemoryOutboxStore([event]);
    const publisher = { publish: vi.fn(() => Promise.resolve()) };
    const dispatcher = new OperationsOutboxDispatcher(store, publisher, () => new Date('2026-08-31T12:00:00.000Z'), () => 'claim-1');
    await dispatcher.dispatch(event.id);
    await dispatcher.dispatch(event.id);
    expect(publisher.publish).toHaveBeenCalledTimes(1);
    expect(store.get(event.id)).toMatchObject({ status: 'PUBLISHED', attempts: 0 });
  });

  it('records a stable failure and permits a later replay', async () => {
    const event = envelope('operations.package.published.v1');
    const store = new InMemoryOutboxStore([event]);
    const publisher = { publish: vi.fn().mockRejectedValueOnce(new Error('broker down')).mockResolvedValueOnce(undefined) };
    let now = new Date('2026-08-31T12:00:00.000Z');
    const dispatcher = new OperationsOutboxDispatcher(store, publisher, () => now, () => `claim-${String(publisher.publish.mock.calls.length)}`);
    await expect(dispatcher.dispatch(event.id)).rejects.toThrow('broker down');
    expect(store.get(event.id)).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'EVENT_PUBLISH_FAILED' });
    now = new Date('2026-08-31T12:01:00.000Z');
    await dispatcher.dispatch(event.id);
    expect(publisher.publish).toHaveBeenCalledTimes(2);
    expect(store.get(event.id)).toMatchObject({ status: 'PUBLISHED', attempts: 1 });
  });
});
