import { describe, expect, it } from 'vitest';
import { FinanceMetrics } from '../src/observability/finance-metrics.js';
import { PaymentHealthService } from '../src/runtime/health.service.js';

describe('payment runtime health and metrics', () => {
  it.each([
    ['postgres', true, false, { postgres: 'down', paymentCertificate: 'up' }],
    ['certificate', false, true, { postgres: 'up', paymentCertificate: 'down' }],
  ] as const)(
    'fails readiness when %s is unavailable',
    async (_name, databaseFails, certificateFails, checks) => {
      const health = new PaymentHealthService(
        {
          ping: () =>
            databaseFails ? Promise.reject(new Error('database unavailable')) : Promise.resolve(),
        },
        {
          isAvailable: () => Promise.resolve(!certificateFails),
        },
      );

      expect(health.liveness()).toEqual({ status: 'ok' });
      await expect(health.readiness()).resolves.toEqual({ ready: false, checks });
    },
  );

  it('exports callback, reconciliation and refund metrics without identifiers', () => {
    const metrics = new FinanceMetrics('payment');
    metrics.increment('callback_failures');
    metrics.set('reconciliation_differences', 2);
    metrics.set('refund_backlog', 4);

    const output = metrics.render();
    expect(output).toContain('payment_callback_failures_total 1');
    expect(output).toContain('payment_reconciliation_differences 2');
    expect(output).toContain('payment_refund_backlog 4');
    expect(output).not.toMatch(/[{}]/);
  });
});
