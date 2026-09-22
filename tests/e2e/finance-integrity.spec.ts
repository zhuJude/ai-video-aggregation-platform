import { test } from '@playwright/test';
import { runWorkspaceCommand } from './suite-process';

test('wallet, payment and provider idempotency invariants pass', () => {
  for (const [workspace, files] of [
    ['@repo/wallet-service', ['test/ledger.property.test.ts', 'test/reconciliation.test.ts']],
    [
      '@repo/payment-service',
      ['test/callback.integration.test.ts', 'test/channel-reconciliation.test.ts'],
    ],
    [
      '@repo/provider-runtime',
      ['test/callback.integration.test.ts', 'test/circuit-execution.integration.test.ts'],
    ],
  ] as const) {
    runWorkspaceCommand(['--filter', workspace, 'exec', 'vitest', 'run', ...files]);
  }
});
