import { test } from '@playwright/test';
import { runWorkspaceCommand } from './suite-process';

test('admin MFA, operations and RBAC acceptance suite passes', () => {
  runWorkspaceCommand([
    '--filter',
    '@repo/admin-web',
    'test:e2e',
    '--',
    'operations.spec.ts',
    'financial-controls.spec.ts',
  ]);
});
