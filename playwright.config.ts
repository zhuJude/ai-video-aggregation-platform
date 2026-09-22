import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  testIgnore: '**/contracts.spec.ts',
  fullyParallel: false,
  workers: 1,
  timeout: 15 * 60_000,
  reporter: 'line',
  outputDir: 'test-results/playwright',
});
