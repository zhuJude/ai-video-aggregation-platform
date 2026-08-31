export class FakeClock {
  constructor(private current: Date = new Date('2026-08-28T00:00:00.000Z')) {}

  now(): Date {
    return new Date(this.current.getTime());
  }

  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export class InMemoryEventBus {
  readonly events: unknown[] = [];

  publish(event: unknown): Promise<void> {
    this.events.push(structuredClone(event));
    return Promise.resolve();
  }
}
