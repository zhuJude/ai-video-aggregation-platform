import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { GET as health } from '../app/health/route';
import { GET as ready } from '../app/ready/route';
import nextConfig from '../next.config';

const appRoot = resolve(import.meta.dirname, '..');

describe('production delivery boundary', () => {
  it('builds a standalone application with browser security headers', async () => {
    expect(nextConfig.output).toBe('standalone');
    expect(nextConfig.outputFileTracingRoot).toBe(resolve(appRoot, '../..'));
    const rules = await nextConfig.headers?.();
    const global = rules?.find((rule) => rule.source === '/:path*');
    const headers = new Map(global?.headers.map((header) => [header.key, header.value]));

    expect(headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'");
    expect(headers.get('Strict-Transport-Security')).toContain('max-age=31536000');
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    expect(headers.get('Permissions-Policy')).toContain('camera=()');
    expect(headers.get('Content-Security-Policy')).not.toContain("'unsafe-eval'");
  });

  it('pins Node and ships a non-root multi-stage image with a liveness probe', async () => {
    await expect(readFile(resolve(appRoot, '.node-version'), 'utf8')).resolves.toBe('24.15.0\n');
    const dockerfile = await readFile(resolve(appRoot, 'Dockerfile'), 'utf8');

    expect(dockerfile).toContain('FROM node:24.15.0-alpine');
    expect(dockerfile.match(/^FROM /gm)).toHaveLength(3);
    expect(dockerfile).toContain('pnpm install --lockfile=false --filter @repo/user-web...');
    expect(dockerfile).toContain('pnpm --config.lockfile=false --filter @repo/user-web build');
    expect(dockerfile).toContain('USER nextjs');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/health');
    expect(dockerfile).not.toMatch(/USER root/);

    const dockerIgnore = await readFile(resolve(appRoot, 'Dockerfile.dockerignore'), 'utf8');
    expect(dockerIgnore).toContain('**/node_modules');
    expect(dockerIgnore).toContain('**/.next');
    expect(dockerIgnore).toContain('apps/user-web/output');
    expect(dockerIgnore).toContain('**/.env*');

    const packageDocument = JSON.parse(
      await readFile(resolve(appRoot, 'package.json'), 'utf8'),
    ) as { readonly devDependencies?: Readonly<Record<string, string>> };
    expect(packageDocument.devDependencies?.tsx).toBe('4.23.12');
    const playwrightConfig = await readFile(resolve(appRoot, 'playwright.config.ts'), 'utf8');
    expect(playwrightConfig).toContain("requireFromConfig.resolve('tsx/package.json')");
    expect(playwrightConfig).not.toContain('../../node_modules/tsx');
  });

  it('separates liveness from dependency readiness without leaking configuration', async () => {
    const previousGateway = process.env.GATEWAY_URL;
    const previousSessionKey = process.env.USER_WEB_SESSION_ENCRYPTION_KEY;
    delete process.env.GATEWAY_URL;
    delete process.env.USER_WEB_SESSION_ENCRYPTION_KEY;
    try {
      const liveResponse = health();
      const unreadyResponse = ready();
      expect(liveResponse.status).toBe(200);
      expect(await liveResponse.json()).toEqual({ status: 'ok' });
      expect(unreadyResponse.status).toBe(503);
      expect(await unreadyResponse.json()).toEqual({ status: 'unavailable' });

      process.env.GATEWAY_URL = 'https://gateway.internal.example';
      process.env.USER_WEB_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64url');
      const readyResponse = ready();
      expect(readyResponse.status).toBe(200);
      expect(await readyResponse.json()).toEqual({ status: 'ready' });
    } finally {
      if (previousGateway === undefined) delete process.env.GATEWAY_URL;
      else process.env.GATEWAY_URL = previousGateway;
      if (previousSessionKey === undefined) delete process.env.USER_WEB_SESSION_ENCRYPTION_KEY;
      else process.env.USER_WEB_SESSION_ENCRYPTION_KEY = previousSessionKey;
    }
  });
});
