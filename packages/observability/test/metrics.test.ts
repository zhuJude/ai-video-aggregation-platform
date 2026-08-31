import { describe, expect, it } from 'vitest';
import { LowCardinalityRegistry } from '../src/metrics.js';

describe('LowCardinalityRegistry', () => {
  it.each(['userId', 'taskId', 'orderId', 'objectKey', 'phone'])(
    'rejects the high-cardinality label %s',
    (label) => {
      const metrics = new LowCardinalityRegistry('reporting_service');
      expect(() => metrics.counter('events_total', 'Events', [label])).toThrow(/high-cardinality/i);
    },
  );

  it('exports business and reliability primitives with bounded labels', async () => {
    const metrics = new LowCardinalityRegistry('reporting_service');
    metrics.business.paymentEffects.inc({ outcome: 'applied' });
    metrics.messaging.lagSeconds.set({ consumer: 'reporting', topic: 'domain-events' }, 3);

    const output = await metrics.metrics();
    expect(output).toContain('reporting_service_payment_effects_total');
    expect(output).toContain('reporting_service_message_lag_seconds');
  });
});
