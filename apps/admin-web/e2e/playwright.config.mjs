import { defineConfig } from '@playwright/test';
import { resolveBrowserExecutable } from './support/browser-executable.mjs';

const browserExecutable = resolveBrowserExecutable();

export default defineConfig({
  fullyParallel: false,
  globalSetup: './support/global-setup.mjs',
  outputDir: '../output/playwright/test-results',
  reporter: [['line'], ['html', { open: 'never', outputFolder: '../output/playwright/report' }]],
  retries: 0,
  testDir: '.',
  testIgnore: ['support/**'],
  timeout: 45_000,
  use: {
    baseURL: 'https://localhost:3210',
    ignoreHTTPSErrors: true,
    launchOptions: browserExecutable ? { executablePath: browserExecutable } : undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { height: 900, width: 1280 },
  },
  workers: 1,
});
