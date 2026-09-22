import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const requestJar = new Map<string, string>();
let responseWrites = new Map<string, string | null>();
let cookieAccessFailure: Error | undefined;
let cookieOperationFailure: Error | undefined;

vi.mock('next/headers', () => ({
  cookies: () => cookieAccessFailure ? Promise.reject(cookieAccessFailure) : Promise.resolve({
    delete(name: string) { if (cookieOperationFailure) throw cookieOperationFailure; responseWrites.set(name, null); },
    get(name: string) { if (cookieOperationFailure) throw cookieOperationFailure; const value = requestJar.get(name); return value ? { value } : undefined; },
    set(name: string, value: string) { if (cookieOperationFailure) throw cookieOperationFailure; responseWrites.set(name, value); },
  }),
}));
import { preparePasswordAction, submitPasswordAction, submitTotpAction } from '../app/login/actions';
import { ADMIN_MFA_CHALLENGE_COOKIE, ADMIN_SESSION_COOKIE, verifyAdminMfaChallenge } from '../lib/session-auth';

const traceIdPattern = /^[0-9a-f]{32}$/u;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function passwordForm(password = 'not-a-real-password'): FormData {
  const form = new FormData();
  form.set('identifier', 'operator@example.invalid');
  form.set('password', password);
  return form;
}
function totpForm(code: string): FormData { const form = new FormData(); form.set('totp', code); return form; }

function expectStrictTelemetryEvent(event: unknown, operation: string, reason: string): void {
  if (!event || typeof event !== 'object') throw new Error('missing telemetry event');
  const candidate = event as Record<string, unknown>;
  expect(Object.keys(candidate).sort()).toEqual(['correlationId', 'operation', 'reason', 'traceId']);
  expect(candidate.operation).toBe(operation);
  expect(candidate.reason).toBe(reason);
  expect(candidate.correlationId).toMatch(uuidV7Pattern);
  expect(candidate.traceId).toMatch(traceIdPattern);
}

describe('production MFA preflight and delivered cookie boundary', () => {
  beforeEach(() => {
    requestJar.clear(); responseWrites = new Map();
    cookieAccessFailure = undefined;
    cookieOperationFailure = undefined;
    process.env.ADMIN_AUTH_API_URL = 'https://iam.example.invalid';
    process.env.ADMIN_AUTH_KMS_IDENTITY_REF = 'kms://service/admin-web';
    process.env.ADMIN_MFA_CHALLENGE_SIGNING_KEY = 'production-mfa-test-signing-key-at-least-32-bytes';
    process.env.ADMIN_SESSION_SIGNING_KEY = 'production-session-test-signing-key-at-least-32-bytes';
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it('requires an applied preflight Set-Cookie and reuses the credential key when the password response is discarded', async () => {
    const requests: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Headers(init?.headers));
      return Promise.resolve(Response.json({ challengeId: 'A'.repeat(43), expiresInSeconds: 600 }));
    }));
    await expect(submitPasswordAction('/overview', null, passwordForm())).resolves.toEqual({ step: 'password', message: '无法建立安全登录，请重试', requiresPreflight: true });
    expect(requests).toHaveLength(0);

    await expect(preparePasswordAction('operator@example.invalid')).resolves.toEqual({ status: 'READY' });
    const delivered = responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE);
    expect(typeof delivered).toBe('string');
    expect(delivered).not.toMatch(/operator@example.invalid|not-a-real-password/u);
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, delivered as string);

    responseWrites = new Map();
    await submitPasswordAction('/overview', null, passwordForm());
    responseWrites = new Map(); // browser discards the first password response and its Set-Cookie
    await submitPasswordAction('/overview', null, passwordForm());
    expect(requests).toHaveLength(2);
    expect(requests[1]?.get('Idempotency-Key')).toBe(requests[0]?.get('Idempotency-Key'));
    expect(requests[1]?.get('X-Correlation-Id')).toBe(requests[0]?.get('X-Correlation-Id'));
    expect(requests[1]?.get('X-Trace-Id')).not.toBe(requests[0]?.get('X-Trace-Id'));
  });

  it('keeps TOTP response-loss retries stable and derives a different key for a different code', async () => {
    const totpHeaders: Headers[] = [];
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (requestUrl.includes('/password/challenges')) return Promise.resolve(Response.json({ challengeId: 'A'.repeat(43), expiresInSeconds: 600 }));
      totpHeaders.push(new Headers(init?.headers));
      return Promise.reject(new Error('response lost'));
    }));
    await preparePasswordAction('operator@example.invalid');
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();
    await submitPasswordAction('/overview', null, passwordForm());
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();
    await submitTotpAction(null, totpForm('111111'));
    await submitTotpAction(null, totpForm('111111'));
    await submitTotpAction(null, totpForm('222222'));
    expect(totpHeaders[1]?.get('Idempotency-Key')).toBe(totpHeaders[0]?.get('Idempotency-Key'));
    expect(totpHeaders[2]?.get('Idempotency-Key')).not.toBe(totpHeaders[0]?.get('Idempotency-Key'));
    expect(totpHeaders.every((headers) => headers.get('X-Correlation-Id') === totpHeaders[0]?.get('X-Correlation-Id'))).toBe(true);
  });

  it('rejects a tainted authenticated subject without issuing a session or tainted challenge cookie', async () => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (requestUrl.includes('/password/challenges')) return Promise.resolve(Response.json({ challengeId: 'A'.repeat(43), expiresInSeconds: 600 }));
      return Promise.resolve(Response.json({
        kind: 'AUTHENTICATED',
        expiresAt: Date.now() + 60_000,
        subject: { dataScope: 'ALL', permissions: ['overview:read'], secret: 'tainted', subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' },
      }));
    }));
    await preparePasswordAction('operator@example.invalid');
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();
    await submitPasswordAction('/overview', null, passwordForm());
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();

    await expect(submitTotpAction(null, totpForm('111111'))).resolves.toMatchObject({ status: 'INVALID_TOTP' });
    expect(responseWrites.has(ADMIN_SESSION_COOKIE)).toBe(false);
    const claims = await verifyAdminMfaChallenge(requestJar.get(ADMIN_MFA_CHALLENGE_COOKIE), process.env.ADMIN_MFA_CHALLENGE_SIGNING_KEY, Date.now());
    expect(claims).not.toHaveProperty('secret');
  });

  it.each([
    ['unknown', ['overview:read', 'root:everything']],
    ['duplicate', ['overview:read', 'overview:read']],
    ['oversized', ['x'.repeat(5000)]],
  ])('rejects %s IAM permissions before the production action writes a session cookie', async (_label, permissions) => {
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (requestUrl.includes('/password/challenges')) return Promise.resolve(Response.json({ challengeId: 'A'.repeat(43), expiresInSeconds: 600 }));
      return Promise.resolve(Response.json({
        kind: 'AUTHENTICATED',
        expiresAt: Date.now() + 60_000,
        subject: { dataScope: 'ALL', permissions, subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' },
      }));
    }));
    await preparePasswordAction('operator@example.invalid');
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();
    await submitPasswordAction('/overview', null, passwordForm());
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();
    await expect(submitTotpAction(null, totpForm('111111'))).resolves.toMatchObject({ status: 'INVALID_TOTP' });
    expect(responseWrites.has(ADMIN_SESSION_COOKIE)).toBe(false);
  });

  it('records one adapter-owned event through the exported password action', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let requestHeaders: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      requestHeaders = new Headers(init?.headers);
      return Promise.resolve(Response.json({ challengeId: 'bad', expiresInSeconds: 600 }));
    }));
    await preparePasswordAction('operator@example.invalid');
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();
    await submitPasswordAction('/overview', null, passwordForm());
    const events = warnings.mock.calls.map((call) => JSON.parse(String(call[1])) as unknown);
    expect(events).toEqual([expect.objectContaining({
      correlationId: requestHeaders?.get('X-Correlation-Id'),
      operation: 'iam.password.begin',
      reason: 'MALFORMED_RESPONSE',
      traceId: requestHeaders?.get('X-Trace-Id'),
    })]);
    expect(requestHeaders?.get('X-Correlation-Id')).toMatch(uuidV7Pattern);
    expect(requestHeaders?.get('X-Trace-Id')).toMatch(traceIdPattern);
    expect(JSON.stringify(events)).not.toMatch(/operator@example\.invalid|not-a-real-password/u);
  });

  it('records one adapter-owned event through the exported TOTP action', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let totpRequestHeaders: Headers | undefined;
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const requestUrl = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (requestUrl.includes('/password/challenges')) return Promise.resolve(Response.json({ challengeId: 'A'.repeat(43), expiresInSeconds: 600 }));
      totpRequestHeaders = new Headers(init?.headers);
      return Promise.resolve(Response.json({ kind: 'CONSUMED', extra: true }));
    }));
    await preparePasswordAction('operator@example.invalid');
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();
    await submitPasswordAction('/overview', null, passwordForm());
    requestJar.set(ADMIN_MFA_CHALLENGE_COOKIE, responseWrites.get(ADMIN_MFA_CHALLENGE_COOKIE) as string);
    responseWrites = new Map();
    await submitTotpAction(null, totpForm('111111'));
    const events = warnings.mock.calls.map((call) => JSON.parse(String(call[1])) as unknown);
    expect(events).toEqual([expect.objectContaining({
      correlationId: totpRequestHeaders?.get('X-Correlation-Id'),
      operation: 'iam.totp.verify',
      reason: 'MALFORMED_RESPONSE',
      traceId: totpRequestHeaders?.get('X-Trace-Id'),
    })]);
    expect(totpRequestHeaders?.get('X-Correlation-Id')).toMatch(uuidV7Pattern);
    expect(totpRequestHeaders?.get('X-Trace-Id')).toMatch(traceIdPattern);
    expect(JSON.stringify(events)).not.toMatch(/111111|A{16}/u);
  });

  it.each([
    ['IAM configuration', () => { process.env.ADMIN_AUTH_API_URL = ''; }, 'iam.config'],
    ['signing configuration', () => { process.env.ADMIN_MFA_CHALLENGE_SIGNING_KEY = ''; }, 'login.config'],
  ])('records exactly one source-owned event for missing %s through the exported action', async (_label, invalidate, operation) => {
    vi.stubEnv('NODE_ENV', 'production');
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    invalidate();

    await expect(preparePasswordAction('operator@example.invalid')).resolves.toEqual({ status: 'ERROR' });

    const events = warnings.mock.calls.map((call) => JSON.parse(String(call[1])) as unknown);
    expect(events).toHaveLength(1);
    expectStrictTelemetryEvent(events[0], operation, 'INVALID_CONFIG');
    expect(JSON.stringify(events)).not.toContain('operator@example.invalid');
  });

  it.each(['headers access', 'cookie operation'])('records one standalone action event per replayed %s failure', async (variant) => {
    vi.stubEnv('NODE_ENV', 'production');
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const cause = new Error('cookie-secret');
    const failure = new Error('outer failure', { cause });
    if (variant === 'headers access') cookieAccessFailure = failure;
    else cookieOperationFailure = failure;

    await preparePasswordAction('operator@example.invalid');
    await preparePasswordAction('operator@example.invalid');

    const events = warnings.mock.calls.map((call) => JSON.parse(String(call[1])) as unknown);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expectStrictTelemetryEvent(event, 'login.action', 'ACTION_FAILURE');
    }
    expect(JSON.stringify(events)).not.toMatch(/cookie-secret|operator@example\.invalid/u);
  });
});
