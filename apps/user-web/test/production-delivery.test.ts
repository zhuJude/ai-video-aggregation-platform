import { readFile } from 'node:fs/promises';
import { generateKeyPairSync } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

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
    expect(dockerfile).toContain(
      'pnpm install --frozen-lockfile --lockfile-dir apps/user-web --filter @repo/user-web...',
    );
    expect(dockerfile).not.toMatch(/lockfile=false|no-lockfile/);
    expect(dockerfile).toContain('USER nextjs');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/health');
    expect(dockerfile).not.toMatch(/USER root/);

    const dockerIgnore = await readFile(resolve(appRoot, 'Dockerfile.dockerignore'), 'utf8');
    expect(dockerIgnore).toContain('**/node_modules');
    expect(dockerIgnore).toContain('**/.next');
    expect(dockerIgnore).toContain('apps/user-web/output');
    expect(dockerIgnore).toContain('**/.env*');

    const dockerLock = await readFile(resolve(appRoot, 'pnpm-lock.yaml'), 'utf8');
    expect(dockerLock).toContain("lockfileVersion: '9.0'");
    expect(dockerLock).toContain('next:');
    expect(dockerLock).toContain('specifier: 16.3.3');

    const packageDocument = JSON.parse(
      await readFile(resolve(appRoot, 'package.json'), 'utf8'),
    ) as { readonly devDependencies?: Readonly<Record<string, string>> };
    expect(packageDocument.devDependencies?.tsx).toBe('4.23.12');
    const playwrightConfig = await readFile(resolve(appRoot, 'playwright.config.ts'), 'utf8');
    expect(playwrightConfig).toContain("requireFromConfig.resolve('tsx/package.json')");
    expect(playwrightConfig).not.toContain('../../node_modules/tsx');
  });

  it('separates liveness from dependency readiness without leaking configuration', async () => {
    const mutableEnv = process.env as Record<string, string | undefined>;
    const names = [
      'GATEWAY_URL',
      'NODE_ENV',
      'USER_WEB_SESSION_ENCRYPTION_KEY',
      'USER_WEB_IDENTITY_VERIFY_KEYS_JSON',
      'USER_WEB_PUBLIC_MODE',
      'USER_WEB_STUDIO_MODE',
      'USER_WEB_COMMERCE_MODE',
      'USER_WEB_SUPPORT_MODE',
    ] as const;
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    try {
      for (const name of names) Reflect.deleteProperty(mutableEnv, name);
      const liveResponse = health();
      const unreadyResponse = await ready();
      expect(liveResponse.status).toBe(200);
      expect(await liveResponse.json()).toEqual({ status: 'ok' });
      expect(unreadyResponse.status).toBe(503);
      expect(await unreadyResponse.json()).toEqual({ status: 'unavailable' });

      process.env.GATEWAY_URL = 'https://gateway.internal.example';
      process.env.USER_WEB_SESSION_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64url');
      const { publicKey } = generateKeyPairSync('ed25519');
      process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON = JSON.stringify([
        {
          kid: 'ready-key',
          spki: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        },
      ]);
      const gatewayHealth = vi.fn().mockResolvedValue(
        Response.json(
          {
            ok: true,
            checks: { redis: true, serviceDns: true, signingKeys: true, futureCheck: true },
          },
          { headers: { 'cache-control': 'no-store' } },
        ),
      );
      vi.stubGlobal('fetch', gatewayHealth);
      const readyResponse = await ready();
      expect(readyResponse.status).toBe(200);
      expect(await readyResponse.json()).toEqual({ status: 'ready' });
      expect(gatewayHealth).toHaveBeenCalledWith(
        new URL('https://gateway.internal.example/health/ready'),
        expect.objectContaining({ cache: 'no-store' }),
      );

      gatewayHealth.mockResolvedValueOnce(Response.json({ ok: false, checks: { redis: false } }));
      expect((await ready()).status).toBe(503);

      gatewayHealth.mockRejectedValueOnce(new Error('connection refused'));
      expect((await ready()).status).toBe(503);

      mutableEnv.NODE_ENV = 'production';
      process.env.USER_WEB_PUBLIC_MODE = ' MOCK ';
      const unsafeProduction = await ready();
      expect(unsafeProduction.status).toBe(503);
      expect(await unsafeProduction.json()).toEqual({ status: 'unavailable' });

      delete process.env.USER_WEB_PUBLIC_MODE;
      process.env.USER_WEB_IDENTITY_VERIFY_KEYS_JSON = '[{"kid":"bad","spki":"bad"}]';
      expect((await ready()).status).toBe(503);
    } finally {
      vi.unstubAllGlobals();
      for (const name of names) {
        const value = previous[name];
        if (value === undefined) Reflect.deleteProperty(mutableEnv, name);
        else mutableEnv[name] = value;
      }
    }
  });

  it('keeps every live public Gateway page request-bound instead of build-time cached', async () => {
    const pages = [
      'app/(marketing)/page.tsx',
      'app/models/page.tsx',
      'app/models/[id]/page.tsx',
      'app/pricing/page.tsx',
      'app/help/[[...slug]]/page.tsx',
    ];
    for (const page of pages) {
      const source = await readFile(resolve(appRoot, page), 'utf8');
      expect(source, page).toContain("export const dynamic = 'force-dynamic'");
    }
  });

  it('keeps the browser acceptance Gateway readiness fixture on the WS09 contract', async () => {
    const source = await readFile(resolve(appRoot, 'e2e/mock-gateway.ts'), 'utf8');
    expect(source).toContain("request.url === '/health/ready'");
    expect(source).toContain('ok: true, checks:');
    expect(source).not.toContain("request.url === '/health'");
  });
});
