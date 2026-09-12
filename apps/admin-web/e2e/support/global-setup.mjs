import { spawn } from 'node:child_process';
import https from 'node:https';
import path from 'node:path';
import process from 'node:process';
import selfsigned from 'selfsigned';
import { fileURLToPath } from 'node:url';

import { createFixtureHandler } from './platform-fixture.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

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
  next.stdout.on('data', (chunk) => { output += String(chunk); });
  next.stderr.on('data', (chunk) => { output += String(chunk); });
  try {
    await waitForHttp('http://127.0.0.1:3210/login', 45_000);
  } catch (error) {
    api.close();
    next.kill();
    throw new Error(`${String(error)}\n${output}`);
  }

  return async () => {
    await new Promise((resolve) => api.close(resolve));
    if (next.exitCode === null) next.kill();
  };
}
