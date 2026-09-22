import { spawn } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import { chromium } from '@playwright/test';
import selfsigned from 'selfsigned';
import { fileURLToPath } from 'node:url';

import { createFixtureHandler } from './platform-fixture.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const appBaseUrl = 'http://127.0.0.1:3210';
const fixtureBaseUrl = 'https://127.0.0.1:3211';
const readinessTimeoutMs = 180_000;
const protectedReadinessPath = '/tasks?cursor=next_1&query=failed-job&status=FAILED';

function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const response = await fetch(url, { redirect: 'manual' });
        if (response.status < 500) return resolve();
      } catch {}
      if (Date.now() - startedAt > timeoutMs) return reject(new Error(`Timed out waiting for ${url}`));
      setTimeout(poll, 300);
    };
    void poll();
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await exited;
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function warmApplication() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(readinessTimeoutMs);
    page.setDefaultNavigationTimeout(readinessTimeoutMs);
    await page.goto(`${appBaseUrl}${protectedReadinessPath}`);
    await page.getByLabel('管理员账号').fill('admin@example.com');
    await page.getByLabel('密码').fill('correct horse battery staple');
    await page.getByRole('button', { name: '准备安全登录' }).click();
    await page.getByRole('button', { name: '继续验证' }).click();
    await page.getByText('双因素验证', { exact: true }).waitFor();
    await page.getByLabel('六位验证码').fill('123456');
    await page.getByRole('button', { name: '验证并登录' }).click();
    await page.waitForURL(`${appBaseUrl}${protectedReadinessPath}`);
    await page.getByRole('heading', { name: '任务运营' }).waitFor();

    const reset = await context.request.post(`${fixtureBaseUrl}/__reset`);
    if (!reset.ok()) throw new Error(`Fixture reset failed during readiness check (${reset.status()})`);
  } finally {
    await context.close();
    await browser.close();
  }
}

export default async function globalSetup() {
  const certificate = await selfsigned.generate(
    [{ name: 'commonName', value: '127.0.0.1' }],
    { days: 1, keySize: 2048 },
  );
  const api = https.createServer(
    { cert: certificate.cert, key: certificate.private },
    createFixtureHandler(),
  );
  await new Promise((resolve, reject) => {
    api.once('error', reject);
    api.listen(3211, '127.0.0.1', resolve);
  });

  const nextCli = path.join(appRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
  const next = spawn(process.execPath, [nextCli, 'dev', '--hostname', '127.0.0.1', '-p', '3210'], {
    cwd: appRoot,
    env: {
      ...process.env,
      ADMIN_AUTH_API_URL: 'https://127.0.0.1:3211',
      ADMIN_AUTH_KMS_IDENTITY_REF: 'kms://e2e/admin-auth',
      ADMIN_CATALOG_API_URL: 'https://127.0.0.1:3211',
      ADMIN_CATALOG_KMS_IDENTITY_REF: 'kms://e2e/catalog',
      ADMIN_EXACT_PHONE_DESCRIPTOR_SIGNING_KEY: 'e2e-phone-descriptor-signing-key-at-least-32-bytes',
      ADMIN_MFA_CHALLENGE_SIGNING_KEY: 'e2e-mfa-challenge-signing-key-at-least-32-bytes',
      ADMIN_OBSERVABILITY_ALLOWED_ORIGINS: 'https://ops.example.com',
      ADMIN_OPERATIONS_API_URL: 'https://127.0.0.1:3211',
      ADMIN_OPERATIONS_KMS_IDENTITY_REF: 'kms://e2e/operations',
      ADMIN_REPORTING_API_URL: 'https://127.0.0.1:3211',
      ADMIN_REPORTING_KMS_IDENTITY_REF: 'kms://e2e/reporting',
      ADMIN_SESSION_SIGNING_KEY: 'e2e-session-signing-key-at-least-32-bytes',
      NODE_TLS_REJECT_UNAUTHORIZED: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  let stopping = false;
  const captureOutput = (chunk) => {
    output = `${output}${String(chunk)}`.slice(-100_000);
  };
  next.stdout.on('data', captureOutput);
  next.stderr.on('data', captureOutput);
  const exitedUnexpectedly = new Promise((_, reject) => {
    next.once('exit', (code, signal) => {
      if (!stopping) {
        reject(new Error(
          `Next dev exited unexpectedly (code=${String(code)}, signal=${String(signal)})\n${output}`,
        ));
      }
    });
  });
  next.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(
        `[admin-web e2e] Next dev exited unexpectedly (code=${String(code)}, signal=${String(signal)})\n${output}`,
      );
    }
  });
  try {
    await Promise.race([
      (async () => {
        await waitForHttp(`${appBaseUrl}/login`, readinessTimeoutMs);
        await warmApplication();
      })(),
      exitedUnexpectedly,
    ]);
  } catch (error) {
    stopping = true;
    await stopChild(next);
    await closeServer(api);
    throw new Error(`${String(error)}\n${output}`);
  }

  return async () => {
    stopping = true;
    await stopChild(next);
    await closeServer(api);
  };
}
