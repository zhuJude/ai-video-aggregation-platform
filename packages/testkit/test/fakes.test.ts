import { describe, expect, it } from 'vitest';
import { FakeClock, InMemoryEventBus } from '../src/index.js';

describe('FakeClock', () => {
  it('advances deterministically without exposing mutable internal state', () => {
    const clock = new FakeClock();
    const initial = clock.now();

    initial.setUTCFullYear(2030);
    clock.advance(1_000);

    expect(clock.now().toISOString()).toBe('2026-08-28T00:00:01.000Z');
  });
});

describe('InMemoryEventBus', () => {
  it('stores a snapshot of each published event', async () => {
    const bus = new InMemoryEventBus();
    const event = { status: 'QUEUED' };

    await bus.publish(event);
    event.status = 'CHANGED';

    expect(bus.events).toEqual([{ status: 'QUEUED' }]);
  });
});
