import { test } from '@playwright/test';
import { runWorkspaceCommand } from './suite-process';

test('commercial success path settles once and conserves wallet points', () => {
  runWorkspaceCommand([
    '--filter',
    '@repo/user-web',
    'exec',
    'vitest',
    'run',
    'test/commercial-journey.test.ts',
    '-t',
    'settles a successful task once',
  ]);
});
