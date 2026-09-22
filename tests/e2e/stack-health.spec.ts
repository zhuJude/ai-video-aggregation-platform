import { test, expect } from '@playwright/test';
import { connect } from 'node:net';

const httpChecks = [
  ['user-web', 'http://127.0.0.1:3100/ready'],
  ['admin-web', 'http://127.0.0.1:3101/login'],
  ['edge-gateway', 'http://127.0.0.1:3102/health/ready'],
  ['identity-service', 'http://127.0.0.1:3110/readyz'],
  ['iam-service', 'http://127.0.0.1:3111/readyz'],
  ['catalog-service', 'http://127.0.0.1:3120/health/ready'],
  ['quote-routing-service', 'http://127.0.0.1:3121/health/ready'],
  ['wallet-service', 'http://127.0.0.1:3122/ready'],
  ['payment-service', 'http://127.0.0.1:3123/ready'],
  ['generation-service', 'http://127.0.0.1:3124/health/ready'],
  ['provider-runtime', 'http://127.0.0.1:3125/health/ready'],
  ['asset-service', 'http://127.0.0.1:3126/health/ready'],
  ['notification-service', 'http://127.0.0.1:3127/health/ready'],
  ['operations-service', 'http://127.0.0.1:3128/health/ready'],
  ['reporting-service', 'http://127.0.0.1:3129/health/ready'],
  ['mock-provider', 'http://127.0.0.1:3130/health/ready'],
] as const;

const tcpChecks = [
  ['postgres', 5432],
  ['redis', 6379],
  ['rocketmq-namesrv', 9876],
  ['minio', 9000],
] as const;

function tcpReady(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const timeout = setTimeout(() => socket.destroy(new Error(`timeout:${String(port)}`)), 2_000);
    socket.once('connect', () => {
      clearTimeout(timeout);
      socket.end();
      resolve();
    });
    socket.once('error', reject);
  });
}

test.describe('complete local platform stack', () => {
  for (const [name, url] of httpChecks) {
    test(`${name} is ready after migration gating`, async ({ request }) => {
      await expect
        .poll(async () => (await request.get(url)).status(), { timeout: 120_000 })
        .toBe(200);
    });
  }

  for (const [name, port] of tcpChecks) {
    test(`${name} accepts local connections`, async () => {
      await expect.poll(() => tcpReady(port).then(() => true), { timeout: 60_000 }).toBe(true);
    });
  }
});
