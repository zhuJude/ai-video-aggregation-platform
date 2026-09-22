import { test } from '@playwright/test';
import { runWorkspaceCommand } from './suite-process';

test('provider failure releases the reservation exactly once', () => {
  runWorkspaceCommand([
    '--filter',
    '@repo/user-web',
    'exec',
    'vitest',
    'run',
    'test/commercial-journey.test.ts',
    '-t',
    'releases a failed task once',
  ]);
});
