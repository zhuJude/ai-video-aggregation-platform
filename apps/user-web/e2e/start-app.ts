import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { request } from 'node:http';
import { resolve } from 'node:path';

const appRoot = resolve(import.meta.dirname, '..');
const nextCli = resolve(appRoot, 'node_modules/next/dist/bin/next');
const certificate = readFileSync(resolve(appRoot, 'e2e/fixtures/localhost-cert.pem'));
const certificateKey = readFileSync(resolve(appRoot, 'e2e/fixtures/localhost-key.pem'));
const mockNamespace = '0198f4d4-21c2-7b7d-8a03-08a0da2ae2e1';
const key = (byte: number) => Buffer.alloc(32, byte).toString('base64url');

const child = spawn(
  process.execPath,
  [nextCli, 'start', '--hostname', '127.0.0.1', '--port', '3101'],
  {
    cwd: appRoot,
    env: {
      ...process.env,
      GATEWAY_URL: 'http://127.0.0.1:4310',
      NEXT_TELEMETRY_DISABLED: '1',
      USER_WEB_PUBLIC_ORIGIN: 'https://localhost:3100',
      USER_WEB_COMMERCE_IDENTITY_KEY: key(23),
      USER_WEB_COMMERCE_MOCK_SIGNING_KEY: key(17),
      USER_WEB_COMMERCE_MOCK_TEST_NAMESPACE: mockNamespace,
      USER_WEB_COMMERCE_MODE: 'mock',
      USER_WEB_E2E_MODE: '1',
      USER_WEB_MOCK_IDENTITY_KEY: key(19),
      USER_WEB_SESSION_ENCRYPTION_KEY: key(7),
      USER_WEB_STUDIO_MODE: 'mock',
      USER_WEB_SUPPORT_MODE: 'mock',
    },
    stdio: 'inherit',
  },
);

const proxy = createServer({ cert: certificate, key: certificateKey }, (incoming, outgoing) => {
  const incomingOrigin = incoming.headers.origin;
  if (incomingOrigin && incomingOrigin !== 'https://localhost:3100') {
    outgoing.writeHead(403);
    outgoing.end();
    return;
  }
  const upstream = request(
    {
      headers: {
        ...incoming.headers,
        host: 'localhost:3100',
        'x-forwarded-host': 'localhost:3100',
        'x-forwarded-proto': 'https',
      },
      hostname: '127.0.0.1',
      method: incoming.method,
      path: incoming.url,
      port: 3101,
    },
    (response) => {
      outgoing.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on('error', () => {
    if (!outgoing.headersSent) outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
});
proxy.listen(3100, 'localhost');

const stop = (signal: NodeJS.Signals) => {
  if (!child.killed) child.kill(signal);
  proxy.close();
};
process.once('SIGINT', () => {
  stop('SIGINT');
});
process.once('SIGTERM', () => {
  stop('SIGTERM');
});
child.once('exit', (code) => {
  proxy.close();
  process.exit(code ?? 1);
});
