import { test } from '@playwright/test';
import { runWorkspaceCommand } from './suite-process';

test('security adapter, callback, rate-limit and ownership suites pass', () => {
  for (const [workspace, files] of [
    ['@repo/edge-gateway', ['test/rate-limit.test.ts']],
    ['@repo/iam-service', ['test/security-adapters.test.ts']],
    ['@repo/payment-service', ['test/callback.integration.test.ts']],
    [
      '@repo/provider-runtime',
      ['test/callback.integration.test.ts', 'test/circuit-breaker.test.ts'],
    ],
    ['@repo/wallet-service', ['test/ledger.property.test.ts']],
  ] as const) {
    runWorkspaceCommand(['--filter', workspace, 'exec', 'vitest', 'run', ...files]);
  }
});
