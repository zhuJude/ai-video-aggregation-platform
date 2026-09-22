import { describe, expect, it } from 'vitest';
import { FinanceMetrics } from '../src/observability/finance-metrics.js';
import { WalletHealthService } from '../src/runtime/health.service.js';

describe('wallet runtime health and metrics', () => {
  it('fails readiness when PostgreSQL is unavailable while liveness stays up', async () => {
    const health = new WalletHealthService({
      ping: () => Promise.reject(new Error('database unavailable')),
    });

    expect(health.liveness()).toEqual({ status: 'ok' });
    await expect(health.readiness()).resolves.toEqual({
      ready: false,
      checks: { postgres: 'down' },
    });
  });

  it('exports required low-cardinality financial metrics without identifiers', () => {
    const metrics = new FinanceMetrics('wallet');
    metrics.increment('ledger_postings');
    metrics.increment('serializable_retries', 2);
    metrics.set('blocked_wallets', 3);

    const output = metrics.render();
    expect(output).toContain('wallet_ledger_postings_total 1');
    expect(output).toContain('wallet_serializable_retries_total 2');
    expect(output).toContain('wallet_blocked_wallets 3');
    expect(output).not.toMatch(/[{}]/);
  });
});
