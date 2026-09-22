import { defineConfig } from '@playwright/test';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';

const browserChannel = process.env.PLAYWRIGHT_CHANNEL;
const requireFromConfig = createRequire(resolve(process.cwd(), 'playwright.config.ts'));
const tsxCli = resolve(dirname(requireFromConfig.resolve('tsx/package.json')), 'dist/cli.mjs');
const tsx = `node "${tsxCli}"`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: [['line'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: 'https://localhost:3100',
    colorScheme: 'dark',
    ignoreHTTPSErrors: true,
    locale: 'zh-CN',
    screenshot: 'only-on-failure',
    timezoneId: 'Asia/Shanghai',
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    ...(browserChannel && browserChannel !== 'chromium' ? { channel: browserChannel } : {}),
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: { viewport: { width: 1440, height: 960 } },
    },
    {
      name: 'mobile-chromium',
      use: {
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: [
    {
      command: `${tsx} e2e/mock-gateway.ts`,
      port: 4310,
      reuseExistingServer: false,
      timeout: 30_000,
    },
    {
      command: `${tsx} e2e/start-app.ts`,
      url: 'https://localhost:3100/health',
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
