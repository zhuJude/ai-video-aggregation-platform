import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isAbsolute, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly scripts: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const serviceRoot = fileURLToPath(new URL('..', import.meta.url));
const workspaceRoot = resolve(serviceRoot, '..', '..');
const packageJson = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
) as PackageManifest;
const schema = readFileSync(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const readinessSource = readFileSync(
  new URL('./prisma-readiness.test.ts', import.meta.url),
  'utf8',
);

describe('Prisma readiness', () => {
  it('pins compatible Prisma and coverage tooling in the service package', () => {
    expect(packageJson.dependencies?.['@prisma/client']).toBe('7.2.0');
    expect(packageJson.devDependencies?.prisma).toBe('7.2.0');
    expect(packageJson.devDependencies?.['@vitest/coverage-v8']).toBe('4.1.11');
  });

  it('exposes CI-visible Prisma validation, generation, and migration smoke scripts', () => {
    expect(packageJson.scripts).toMatchObject({
      'prisma:check': 'pnpm run prisma:validate && pnpm run prisma:migrate:smoke',
      'prisma:validate': 'prisma validate',
      'prisma:generate':
        'prisma generate && prettier --write --ignore-path ../../.prettierignore "src/generated/prisma/**/*.ts"',
      'prisma:migrate:smoke':
        'prisma migrate diff --config prisma.schema-tools.config.ts --from-empty --to-schema prisma/schema.prisma --script',
    });
    expect(packageJson.scripts.build).toContain('prisma:generate');
  });

  it('generates the service-owned client before every clean-checkout compiler test entrypoint', () => {
    expect(packageJson.scripts).toMatchObject({
      prelint: 'pnpm run prisma:generate',
      pretypecheck: 'pnpm run prisma:generate',
      pretest: 'pnpm run prisma:generate',
      'pretest:coverage': 'pnpm run prisma:generate',
    });
  });

  it('does not run synchronous nested package-manager processes inside Vitest', () => {
    const synchronousSpawnApi = ['spawn', 'Sync'].join('');

    expect(readinessSource).not.toContain(synchronousSpawnApi);
  });

  it('configures Prisma generation for a service-owned isolated output', () => {
    const generator = /generator client \{([\s\S]*?)\r?\n\}/.exec(schema)?.[1];
    const output = /\boutput\s*=\s*"([^"]+)"/.exec(generator ?? '')?.[1];

    expect(generator).toMatch(/\bprovider\s*=\s*"prisma-client"/);
    expect(output).toBe('../src/generated/prisma');
    if (output === undefined) return;

    const resolvedOutput = resolve(serviceRoot, 'prisma', output);
    const outputRelativeToService = relative(serviceRoot, resolvedOutput);
    const sharedVirtualStore = resolve(workspaceRoot, 'node_modules', '.pnpm');

    expect(isAbsolute(outputRelativeToService)).toBe(false);
    expect(outputRelativeToService.startsWith('..')).toBe(false);
    expect(resolvedOutput).toBe(resolve(serviceRoot, 'src', 'generated', 'prisma'));
    expect(relative(sharedVirtualStore, resolvedOutput).startsWith('..')).toBe(true);
    expect(existsSync(resolve(serviceRoot, '.gitignore'))).toBe(true);
    if (!existsSync(resolve(serviceRoot, '.gitignore'))) return;

    expect(readFileSync(resolve(serviceRoot, '.gitignore'), 'utf8')).toContain(
      'src/generated/prisma/',
    );
  });
});
