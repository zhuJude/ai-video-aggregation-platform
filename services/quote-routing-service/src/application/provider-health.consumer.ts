import { z } from 'zod';

const ProviderHealthEventSchema = z.object({
  eventType: z.enum(['provider.health-updated.v1', 'provider.balance-updated.v1']),
  messageId: z.string().min(1),
  providerId: z.string().min(1),
  sequence: z.int().positive(),
  health: z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY']),
  balanceLow: z.boolean(),
  quotaExhausted: z.boolean(),
  circuitOpen: z.boolean(),
  occurredAt: z.iso.datetime(),
});

export type ProviderHealthEvent = z.infer<typeof ProviderHealthEventSchema>;
export type HealthApplyResult = 'APPLIED' | 'DUPLICATE' | 'STALE';

export interface ProviderHealthStore {
  apply(event: ProviderHealthEvent): Promise<HealthApplyResult>;
}

export class InMemoryProviderHealthStore implements ProviderHealthStore {
  private readonly inbox = new Set<string>();
  private readonly snapshots = new Map<string, ProviderHealthEvent>();

  apply(event: ProviderHealthEvent): Promise<HealthApplyResult> {
    if (this.inbox.has(event.messageId)) return Promise.resolve('DUPLICATE');
    this.inbox.add(event.messageId);
    const current = this.snapshots.get(event.providerId);
    if (current && current.sequence >= event.sequence) return Promise.resolve('STALE');
    this.snapshots.set(event.providerId, structuredClone(event));
    return Promise.resolve('APPLIED');
  }

  get(providerId: string): ProviderHealthEvent | undefined {
    const snapshot = this.snapshots.get(providerId);
    return snapshot ? structuredClone(snapshot) : undefined;
  }
}

export class ProviderHealthConsumer {
  constructor(private readonly store: ProviderHealthStore) {}

  consume(input: unknown): Promise<HealthApplyResult> {
    return this.store.apply(ProviderHealthEventSchema.parse(input));
  }
}
