import { defineConfig } from '@playwright/test';

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
    baseURL: 'http://127.0.0.1:3210',
    ignoreHTTPSErrors: true,
    launchOptions: process.env.PLAYWRIGHT_EXECUTABLE_PATH
      ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE_PATH }
      : undefined,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    viewport: { height: 900, width: 1280 },
  },
  workers: 1,
});
