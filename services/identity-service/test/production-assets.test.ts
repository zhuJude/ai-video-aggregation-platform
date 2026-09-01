import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const workspace = resolve(import.meta.dirname, '../../..');

describe('identity and IAM production assets', () => {
  it.each(['identity-service', 'iam-service'])('%s image is Node 24, multi-stage and non-root', async (service) => {
    const dockerfile = await readFile(resolve(workspace, 'services', service, 'Dockerfile'), 'utf8');
    const dockerignore = await readFile(resolve(workspace, 'services', service, 'Dockerfile.dockerignore'), 'utf8');
    const localLock = await readFile(resolve(workspace, 'services', service, 'pnpm-lock.yaml'), 'utf8');
    const localBuildPolicy = await readFile(resolve(workspace, 'services', service, 'pnpm-workspace.yaml'), 'utf8');
    const servicePackage = JSON.parse(await readFile(resolve(workspace, 'services', service, 'package.json'), 'utf8')) as { scripts?: { build?: string } };
    const serviceTsconfig = JSON.parse(await readFile(resolve(workspace, 'services', service, 'tsconfig.json'), 'utf8')) as { extends?: string };
    expect(dockerfile).toContain('FROM node:24-alpine AS build');
    expect(dockerfile).toContain('FROM node:24-alpine AS runtime');
    expect(dockerfile).toContain('COPY tsconfig.base.json ./');
    expect(dockerfile).toContain(`COPY services/${service}/package.json services/${service}/pnpm-lock.yaml services/${service}/pnpm-workspace.yaml ./`);
    expect(dockerfile).toMatch(/pnpm install .*--frozen-lockfile.*--ignore-workspace/);
    expect(dockerfile).toMatch(/pnpm install .*--ignore-scripts/);
    expect(dockerfile).toMatch(/pnpm install .*--config\.strict-dep-builds=false/);
    expect(dockerfile).toContain('pnpm rebuild @prisma/engines');
    expect(dockerfile).not.toContain('--lockfile=false');
    expect(dockerfile).not.toContain('--no-frozen-lockfile');
    expect(dockerfile).toMatch(/pnpm prune .*--prod.*--ignore-workspace/);
    expect(localLock).toContain('lockfileVersion:');
    expect(localLock).toContain(`'@nestjs/common':`);
    expect(localBuildPolicy).toContain('allowBuilds:');
    expect(localBuildPolicy).toContain("'@prisma/engines': true");
    expect(localBuildPolicy).not.toMatch(/dangerouslyAllowAllBuilds|\*\s*:\s*true/);
    expect(dockerfile).toContain('USER node');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('dist/src/main.js');
    expect(dockerfile).not.toMatch(/ACCESS_KEY|\.env\s/);
    expect(serviceTsconfig.extends).toBe('../../tsconfig.base.json');
    expect(servicePackage.scripts?.build).toContain('tsc -p tsconfig.json');
    const rules = dockerignore.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    expect(rules[0]).toBe('**');
    for (const allowed of [
      '!tsconfig.base.json', `!services/${service}/package.json`, `!services/${service}/pnpm-lock.yaml`,
      `!services/${service}/pnpm-workspace.yaml`,
      `!services/${service}/tsconfig.json`,
      `!services/${service}/prisma.config.ts`, `!services/${service}/src/**`,
      `!services/${service}/scripts/**`, `!services/${service}/prisma/**`,
    ]) expect(rules).toContain(allowed);
    for (const denied of [
      '**/.git/**', '**/.env', '**/.env.*', '**/test/**', '**/coverage/**',
      '**/node_modules/**', '**/*.pem', '**/*.key', '**/*credentials*.json',
      '**/*credentials*.yaml', '**/*credentials*.yml', '**/secrets.json', '**/secrets.yaml', '**/secrets.yml',
    ]) expect(rules).toContain(denied);
    expect(rules.some((rule) => /(?:test|coverage|node_modules|\.env|secret|\.git)/i.test(rule) && rule.startsWith('!'))).toBe(false);

    const trackedBuildInputs = trackedFiles().filter((path) =>
      path === 'tsconfig.base.json'
      || path === `services/${service}/Dockerfile`
      || path === `services/${service}/package.json`
      || path === `services/${service}/pnpm-lock.yaml`
      || path === `services/${service}/pnpm-workspace.yaml`
      || path === `services/${service}/tsconfig.json`
      || path === `services/${service}/prisma.config.ts`
      || path.startsWith(`services/${service}/src/`)
      || path.startsWith(`services/${service}/scripts/`)
      || path.startsWith(`services/${service}/prisma/`),
    );
    expect(trackedBuildInputs.length).toBeGreaterThan(20);
    expect(trackedBuildInputs.filter((path) => !includedByDockerignore(path, rules))).toEqual([]);

    for (const credentialPath of [
      `services/${service}/.env`,
      `services/${service}/.env.production`,
      `services/${service}/src/deploy/private.pem`,
      `services/${service}/src/deploy/tls.key`,
      `services/${service}/src/deploy/credentials.json`,
      `services/${service}/src/deploy/aliyun-credentials.yaml`,
      `services/${service}/src/deploy/secrets.yml`,
    ]) expect(includedByDockerignore(credentialPath, rules)).toBe(false);
  });

  it('documents secure operations, rotations, outages, cleanup and rollback', async () => {
    const runbook = await readFile(resolve(workspace, 'docs/runbooks/identity-iam.md'), 'utf8');
    for (const required of [
      '/healthz', '/readyz', '/metrics', 'WS20', 'strictDepBuilds', 'RAM/OIDC',
      'TOTP', 'Recovery', 'HMAC', 'JWT', 'overlap', 'Aliyun SMS outage',
      'Redis/Tair outage', 'Last super-admin', 'Audit export', 'Pending cleanup', 'Rollback',
      'adapter_stuck', 'IDENTITY_DATABASE_OPERATION_TIMEOUT_MS', 'IAM_DATABASE_OPERATION_TIMEOUT_MS',
      '1000–3600000 ms',
      'docker build -f services/identity-service/Dockerfile .',
      'docker build -f services/iam-service/Dockerfile .',
    ]) expect(runbook).toContain(required);
    expect(runbook).toContain('never committed');
    expect(runbook).not.toMatch(/AccessKeySecret\s*[=:]\s*\S+/i);
  });

  it('starts real listeners and drains both services on SIGTERM/SIGINT', async () => {
    const basePort = 41_000 + (process.pid % 1_000) * 2;
    const identityKey = (name: string) => `kms://identity/${name}#version=v1`;
    await probeProcess(
      resolve(workspace, 'services/identity-service/src/main.ts'),
      basePort,
      'SIGTERM',
      'identity_service_started',
      'identity_service_stopping',
      'identity_cloud_resources_closed',
      {
        IDENTITY_DATABASE_URL: 'postgresql://unavailable:unavailable@127.0.0.1:1/identity',
        IDENTITY_REDIS_URL: 'redis://127.0.0.1:1/15',
        IDENTITY_SMS_CHALLENGE_KMS_KEY_REF: identityKey('sms'),
        IDENTITY_PRIVACY_KMS_KEY_REF: identityKey('privacy'),
        IDENTITY_JWT_SIGNING_KMS_KEY_REF: identityKey('jwt'),
        IDENTITY_SMS_SIGN_NAME_KMS_REF: identityKey('sign'),
        IDENTITY_SMS_TEMPLATE_KMS_REF: identityKey('template'),
        IDENTITY_SMS_ROLE_KMS_REF: identityKey('role'),
        IDENTITY_SMS_CREDENTIAL_KIND: 'ecs_ram_role',
      },
    );
    const iamKey = (name: string) => `acs:kms:cn-hangzhou:123456:key/${name}:version/v1`;
    await probeProcess(
      resolve(workspace, 'services/iam-service/src/main.ts'),
      basePort + 1,
      'SIGINT',
      'iam_service_started',
      'iam_service_stopping',
      'iam_cloud_resources_closed',
      {
        IAM_DATABASE_URL: 'postgresql://unavailable:unavailable@127.0.0.1:1/iam',
        IAM_REDIS_URL: 'redis://127.0.0.1:1/15',
        IAM_JWT_SIGNING_KMS_KEY_REF: iamKey('jwt'), IAM_TOTP_KMS_KEY_REF: iamKey('totp'),
        IAM_LOGIN_HMAC_KMS_KEY_REF: iamKey('hmac'), IAM_RECOVERY_PEPPER_KMS_KEY_REF: iamKey('pepper'),
        IAM_BOOTSTRAP_PROOF_KMS_REF: iamKey('bootstrap'), IAM_KMS_IDENTITY_MODE: 'ecs_ram_role',
        IAM_KMS_ECS_RAM_ROLE_NAME: 'iam-service-role',
        IAM_DUMMY_PASSWORD_HASH: '$argon2id$v=19$m=65536,p=1,t=3$aWFtLWR1bW15LXNhbHQtdjEh$sS8ky5sVrjEWO/XGr1C11lT6qVhj8IbY+eDsxB3/eys',
      },
    );
  }, 30_000);
});

async function probeProcess(
  script: string,
  port: number,
  signal: 'SIGTERM' | 'SIGINT',
  startedEvent: string,
  stoppedEvent: string,
  cloudClosedEvent: string,
  serviceEnvironment: Record<string, string>,
): Promise<void> {
  const windows = process.platform === 'win32';
  const scriptUrl = pathToFileURL(script).href;
  const child = spawn(process.execPath, windows
    ? ['--import', 'tsx', '--eval', `import(${JSON.stringify(scriptUrl)}).then(({ bootstrap }) => bootstrap()); process.on('message', (signal) => { process.disconnect(); process.emit(signal); });`]
    : ['--import', 'tsx', script], {
    cwd: dirname(dirname(script)),
    env: { ...process.env, ...serviceEnvironment, IDENTITY_PORT: String(port), IAM_PORT: String(port) },
    stdio: windows ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const { stdout, stderr } = child;
  if (!stdout || !stderr) throw new Error('PROCESS_OUTPUT_PIPE_UNAVAILABLE');
  stdout.setEncoding('utf8'); stderr.setEncoding('utf8');
  stdout.on('data', (chunk: string) => { output += chunk; });
  stderr.on('data', (chunk: string) => { output += chunk; });
  try {
    await waitFor(() => output.includes(startedEvent), 10_000);
    await waitFor(async () => (await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status === 200, 5_000);
    if (windows) child.send(signal);
    else child.kill(signal);
    const exitCode = await new Promise<number | null>((resolveExit, reject) => {
      child.once('exit', resolveExit); child.once('error', reject);
    });
    expect(exitCode).toBe(0);
    expect(output).toContain(stoppedEvent);
    expect(output).toContain(cloudClosedEvent);
    expect(output).not.toContain('runtime_shutdown_failed');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
  }
}

async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() >= deadline) throw new Error('PROCESS_START_TIMEOUT');
    await new Promise((resolveDelay) => { setTimeout(resolveDelay, 25); });
  }
}

function trackedFiles(): readonly string[] {
  return execFileSync('git', ['ls-files'], { cwd: workspace, encoding: 'utf8' })
    .split(/\r?\n/).filter(Boolean).map((path) => path.replaceAll('\\', '/'));
}

function includedByDockerignore(path: string, rules: readonly string[]): boolean {
  let included = true;
  for (const rule of rules) {
    const negated = rule.startsWith('!');
    const pattern = negated ? rule.slice(1) : rule;
    if (dockerPattern(pattern).test(path)) included = negated;
  }
  return included;
}

function dockerPattern(pattern: string): RegExp {
  let expression = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') {
        expression += '(?:.*/)?';
        index += 2;
      } else {
        expression += '.*';
        index += 1;
      }
    } else if (character === '*') expression += '[^/]*';
    else if (character === '?') expression += '[^/]';
    else expression += character?.replace(/[\\^$.[\]{}()+|]/g, '\\$&') ?? '';
  }
  return new RegExp(`^${expression}$`);
}
