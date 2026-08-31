/* eslint-disable @typescript-eslint/require-await -- async fetch fakes implement the platform contract. */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttpUserOperationPorts } from '../lib/http-user-operation-port';
import { createOutboundRequestContext } from '../lib/outbound-request-context';

const environment = {
  apiUrl: 'https://operations.example.invalid',
  kmsIdentityReference: 'kms://service/admin-web',
};

function requestContext(
  traceId = '00112233445566778899aabbccddeeff',
  correlationId = '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f',
) {
  return createOutboundRequestContext(() => traceId, () => correlationId);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
    status,
  });
}

function validAuthoritativeDetail() {
  return {
    allowedStatusTransitions: ['SUSPENDED'],
    canRequestWalletAdjustment: false,
    deniedTabs: [] as string[],
    eligibleApprovers: [{ displayName: '复核管理员', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }],
    tabs: [
      { account: { createdAt: '2026-08-30T10:00:00.000Z', displayName: '用户', phoneMasked: '138****8000', registrationSource: 'WEB', status: 'ACTIVE', spendingTier: 'HIGH', tags: [{ value: 'vip' }] }, id: 'account', session: { devices: [{ id: '0198f7a4-c6e0-7b39-8a4e-73af0c1d2e3f', lastSeenAt: '2026-08-31T08:00:00.000Z', platform: 'iOS', status: 'ACTIVE' }], lastActiveAt: '2026-08-31T08:00:00.000Z', loginRecords: [{ deviceLabel: 'iPhone', id: '0198f7a4-c6e1-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', status: 'SUCCESS' }], status: 'ACTIVE' }, status: 'READY' },
      { id: 'tasks', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e2-7b39-8a4e-73af0c1d2e3f', status: 'SUCCEEDED' }], status: 'READY' },
      { adjustmentHistory: [{ direction: 'CREDIT', id: '0198f7a4-c6e5-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '5', status: 'APPROVED' }], balance: '1', consumptionHistory: [{ direction: 'DEBIT', id: '0198f7a4-c6e4-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '1', status: 'SETTLED' }], frozenBalance: '0', id: 'wallet', rechargeHistory: [{ direction: 'CREDIT', id: '0198f7a4-c6e3-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T08:00:00.000Z', points: '1', status: 'SETTLED' }], status: 'READY', unit: 'POINTS' },
      { id: 'orders', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e6-7b39-8a4e-73af0c1d2e3f', status: 'PAID' }], status: 'READY' },
      { id: 'tickets', items: [{ createdAt: '2026-08-31T07:00:00.000Z', id: '0198f7a4-c6e7-7b39-8a4e-73af0c1d2e3f', status: 'OPEN' }], status: 'READY' },
      { id: 'audit', items: [{ action: 'VIEWED', id: '0198f7a4-c6e8-7b39-8a4e-73af0c1d2e3f', occurredAt: '2026-08-31T07:00:00.000Z' }], status: 'READY' },
    ],
    user: { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'ACTIVE' },
  };
}

type MutableDetail = ReturnType<typeof validAuthoritativeDetail>;

function records(payload: MutableDetail, tabId: string, key: string): Array<Record<string, unknown>> {
  const tab = payload.tabs.find((candidate) => candidate.id === tabId) as unknown as Record<string, unknown> | undefined;
  const value = tab?.[key];
  if (!Array.isArray(value)) throw new Error(`missing ${tabId}.${key}`);
  return value as Array<Record<string, unknown>>;
}

function firstRecord(payload: MutableDetail, tabId: string, key: string): Record<string, unknown> {
  const [record] = records(payload, tabId, key);
  if (!record) throw new Error(`missing ${tabId}.${key}[0]`);
  return record;
}

function telemetryCapture() {
  const events: unknown[] = [];
  return {
    events,
    telemetry: {
      record(event: unknown) {
        events.push(event);
      },
    },
  };
}

function expectSingleTelemetry(
  events: readonly unknown[],
  operation: string,
  reason: string,
): void {
  expect(events).toHaveLength(1);
  const event = events[0];
  if (!event || typeof event !== 'object') throw new Error('missing telemetry event');
  const candidate = event as Record<string, unknown>;
  expect(Object.keys(candidate).sort()).toEqual(['correlationId', 'operation', 'reason', 'traceId']);
  expect(candidate.operation).toBe(operation);
  expect(candidate.reason).toBe(reason);
  expect(candidate.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  expect(candidate.traceId).toMatch(/^[0-9a-f]{32}$/u);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HTTP user operation ports', () => {
  it('uses a protected POST body for exact phone and never places it in the request URL or result', async () => {
    let requestedUrl = ''; let request: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = input instanceof Request ? input.url : input instanceof URL ? input.href : input; request = init;
      return jsonResponse({ expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [{ displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'ACTIVE' }], searchHandle: 'opaque_search_handle_1234567890' });
    }));
    const ports = createHttpUserOperationPorts(environment) as ReturnType<typeof createHttpUserOperationPorts> & { exactPhonePort: { lookupExactPhone(input: unknown): Promise<unknown> } };
    const result = await ports.exactPhonePort.lookupExactPhone({ phone: '13800138000', scope: 'ASSIGNED', trustedSessionToken: 'trusted-session', requestContext: requestContext('0123456789abcdef0123456789abcdef') });

    expect(requestedUrl).toBe('https://operations.example.invalid/v1/admin/users/exact-phone-lookups');
    expect(requestedUrl).not.toContain('13800138000');
    expect(request?.method).toBe('POST');
    const requestBody = request?.body;
    if (typeof requestBody !== 'string') throw new Error('missing exact lookup request body');
    expect(JSON.parse(requestBody)).toEqual({ phone: '13800138000', scope: 'ASSIGNED' });
    expect(JSON.stringify(result)).not.toContain('13800138000');
  });

  it('rejects a phone-shaped ordinary query and whitespace-wrapped exact phone before fetch', async () => {
    let calls = 0; const ports = createHttpUserOperationPorts(environment) as ReturnType<typeof createHttpUserOperationPorts> & { exactPhonePort: { lookupExactPhone(input: unknown): Promise<unknown> } };
    vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return jsonResponse({ items: [], nextCursor: null }); }));
    await expect(ports.directoryPort.searchUsers({ query: '13800138000', trustedSessionToken: 'trusted-session' } as never)).rejects.toThrow(/sensitive/iu);
    await expect(ports.exactPhonePort.lookupExactPhone({ phone: '13800138000 ', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid exact phone lookup');
    expect(calls).toBe(0);
  });

  it.each([
    { query: 'member-13800138000' },
    { query: '', cursor: '+86-138-0013-8000' },
    { query: '', filters: { tag: 'vip-１３８００１３８０００' } },
  ])('rejects sensitive ordinary directory input before the HTTP adapter emits a request', async (input) => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], nextCursor: null }));
    const port = createHttpUserOperationPorts(environment, { fetchImpl: fetchMock }).directoryPort;
    await expect(port.searchUsers({ ...input, trustedSessionToken: 'trusted-session' })).rejects.toThrow(/sensitive/iu);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed directory cursor before fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ items: [], nextCursor: null }));
    const port = createHttpUserOperationPorts(environment, { fetchImpl: fetchMock }).directoryPort;
    await expect(port.searchUsers({ cursor: ' bad cursor ', query: '', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid user directory cursor');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not expose the dead refresh-user mutation port', () => {
    expect(createHttpUserOperationPorts(environment)).not.toHaveProperty('operationPort');
  });

  it('validates HTTPS and KMS configuration at construction', () => {
    const capture = telemetryCapture();

    expect(() =>
      createHttpUserOperationPorts(
        { apiUrl: 'http://operations.example.invalid' },
        { telemetry: capture.telemetry },
      ),
    ).toThrow();
    expectSingleTelemetry(capture.events, 'operations.config', 'INVALID_CONFIG');
  });

  it('requires and propagates one frozen trace/correlation context on every Task2 outbound request while keeping mutation idempotency separate', async () => {
    const calls: Array<{ init?: RequestInit; url: string }> = [];
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof URL ? input.href : typeof input === 'string' ? input : input.url;
      calls.push({ ...(init ? { init } : {}), url });
      if (url.endsWith('/authorization-scope')) return jsonResponse({ assignedAdminIds: [], ownerAdminId: null, userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' });
      if (url.endsWith('/status-change-requests')) return jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f' }, 202);
      if (url.endsWith('/eligible-approvers')) return jsonResponse([{ displayName: '复核管理员', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }]);
      if (url.endsWith('/wallet-adjustment-previews')) return jsonResponse({ after: '110', before: '100', direction: 'CREDIT', expiresAt: new Date(Date.now() + 60_000).toISOString(), impact: 'ledger', points: '10', policy: 'two-person', previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456' });
      if (url.endsWith('/wallet-adjustment-requests')) return jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', requestId: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f', status: 'PENDING_APPROVAL' });
      if (url.endsWith('/csv-export-requests')) return jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://downloads.example.invalid/users.csv', expiresAt: new Date(Date.now() + 60_000).toISOString() });
      if (url.endsWith('/exact-phone-lookups')) return jsonResponse({ expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [], searchHandle: 'opaque_search_handle_1234567890' });
      if (url.includes('/detail')) return jsonResponse(validAuthoritativeDetail());
      if (url.includes('/v1/admin/users?')) return jsonResponse({ items: [{ displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'ACTIVE' }], nextCursor: null });
      throw new Error(`unexpected request ${url}`);
    });
    const ports = createHttpUserOperationPorts(environment, { fetchImpl });
    const context = requestContext('0123456789abcdef0123456789abcdef');
    const common = { requestContext: context, trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' };
    const audit = { idempotencyKey: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f' };

    await ports.scopePort.getUserScope(common);
    await ports.statusPort.requestStatusChange({ ...common, audit, reason: '违反规则', targetStatus: 'SUSPENDED' });
    await ports.adjustmentPort.getEligibleApprovers({ ...common, dataScope: 'ALL' });
    await ports.adjustmentPort.previewAdjustment?.({ ...common, approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit, direction: 'CREDIT', points: 10n, reason: '人工补偿' });
    await ports.adjustmentPort.submitAdjustmentRequest({ ...common, approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit, direction: 'CREDIT', points: 10n, previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456', reason: '人工补偿' });
    await ports.exportPort.requestCsvExport({ audit, reason: '合规导出', requestContext: context, scope: 'ALL', trustedSessionToken: 'trusted-session' });
    await ports.directoryPort.searchUsers({ query: '', requestContext: context, trustedSessionToken: 'trusted-session' });
    await ports.exactPhonePort.lookupExactPhone({ phone: '13800138000', requestContext: context, scope: 'ALL', trustedSessionToken: 'trusted-session' });
    await ports.detailPort.getUserDetail(common);

    expect(calls).toHaveLength(9);
    for (const call of calls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('X-Trace-Id')).toBe(context.traceId);
      expect(headers.get('X-Correlation-Id')).toBe(context.correlationId);
    }
    const mutationCalls = calls.filter(
      (call) =>
        call.init?.method === 'POST' &&
        !call.url.endsWith('/eligible-approvers') &&
        !call.url.endsWith('/exact-phone-lookups'),
    );
    for (const call of mutationCalls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('Idempotency-Key')).toBe(audit.idempotencyKey);
      expect(headers.get('Idempotency-Key')).not.toBe(headers.get('X-Correlation-Id'));
      expect(headers.get('Idempotency-Key')).not.toBe(headers.get('X-Trace-Id'));
    }
  });

  it('adds deadlines and KMS identity to scope reads', async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) => {
        request = init;
        return jsonResponse({ userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', ownerAdminId: null, assignedAdminIds: [] });
      }),
    );
    const { scopePort } = createHttpUserOperationPorts(environment, {
      deadlineMs: 25,
    });

    await scopePort.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' });

    expect(request?.signal).toBeInstanceOf(AbortSignal);
    expect(request?.redirect).toBe('error');
    expect(new Headers(request?.headers).get('X-Service-Identity-Ref')).toBe(
      environment.kmsIdentityReference,
    );
  });

  it('binds scope lookup to the trusted session and exact authoritative user identity', async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => { request = init; return jsonResponse({ assignedAdminIds: [], ownerAdminId: null, userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' }); }));
    const { scopePort } = createHttpUserOperationPorts(environment);
    await expect(scopePort.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).resolves.toEqual({ assignedAdminIds: [], ownerAdminId: null });
    expect(new Headers(request?.headers).get('X-Admin-Session-Token')).toBe('trusted-session');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ assignedAdminIds: [], ownerAdminId: null, userId: '0198f7a4-c6d0-7b39-8a4e-73af0c1d2e3f' })));
    const mismatched = createHttpUserOperationPorts(environment).scopePort;
    await expect(mismatched.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow('Invalid resource scope response');
    await expect(mismatched.getUserScope({ trustedSessionToken: '', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow();
  });

  it('binds authoritative UUIDv7 identities case-insensitively and rejects case-only duplicates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ assignedAdminIds: [], ownerAdminId: null, userId: '0198F7A4-C6D1-7B39-8A4E-73AF0C1D2E3F' })));
    await expect(createHttpUserOperationPorts(environment).scopePort.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).resolves.toEqual({ assignedAdminIds: [], ownerAdminId: null });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({
      assignedAdminIds: ['0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', '0198F7A4-C6D2-7B39-8A4E-73AF0C1D2E3F'],
      ownerAdminId: null,
      userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
    })));
    await expect(createHttpUserOperationPorts(environment).scopePort.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow('Invalid resource scope response');
  });

  it('aborts timed-out operations calls with sanitized telemetry', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          if (!init?.signal) {
            reject(new Error('missing deadline'));
            return;
          }
          init.signal.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'AbortError'));
          });
        }),
      ),
    );
    const { scopePort } = createHttpUserOperationPorts(environment, {
      deadlineMs: 1,
      telemetry: capture.telemetry,
    });

    await expect(scopePort.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow();
    expectSingleTelemetry(capture.events, 'operations.scope.read', 'TIMEOUT');
    expect(JSON.stringify(capture.events)).not.toContain('0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f');
  });

  it('keeps the deadline active while consuming an operations response body', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) =>
        ({
          ok: true,
          json: () =>
            new Promise<unknown>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                reject(new DOMException('timed out', 'AbortError'));
              });
            }),
        }) as Response,
      ),
    );
    const { scopePort } = createHttpUserOperationPorts(environment, {
      deadlineMs: 1,
      telemetry: capture.telemetry,
    });

    await expect(scopePort.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow();
    expectSingleTelemetry(capture.events, 'operations.scope.read', 'TIMEOUT');
  });

  it('rejects malformed scope responses and records a reason code', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', ownerAdminId: 7, assignedAdminIds: [] })),
    );
    const { scopePort } = createHttpUserOperationPorts(environment, {
      telemetry: capture.telemetry,
    });

    await expect(scopePort.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow();
    expectSingleTelemetry(capture.events, 'operations.scope.read', 'MALFORMED_RESPONSE');
  });

  it.each([
    { userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', assignedAdminIds: Array.from({ length: 101 }, (_, index) => `admin-${String(index)}`), ownerAdminId: null },
    { userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', assignedAdminIds: [''], ownerAdminId: null },
    { userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', assignedAdminIds: ['550e8400-e29b-41d4-a716-446655440000'], ownerAdminId: null },
    { userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', assignedAdminIds: ['arbitrary-admin'], ownerAdminId: null },
    { userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', assignedAdminIds: [], ownerAdminId: '550e8400-e29b-41d4-a716-446655440000' },
    { userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', assignedAdminIds: [], ownerAdminId: 'arbitrary-admin' },
    { userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', assignedAdminIds: ['0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f', '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f'], ownerAdminId: null },
  ])('rejects unbounded, non-v7, empty, or duplicate authoritative scope identities', async (payload) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { scopePort } = createHttpUserOperationPorts(environment);
    await expect(scopePort.getUserScope({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow('Invalid resource scope response');
  });


  it('sends frozen trace/correlation headers and rejects malformed request context at every HTTP mutation boundary', async () => {
    let request: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      request = init;
      return jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f' }, 202);
    });
    vi.stubGlobal('fetch', fetchMock);
    const ports = createHttpUserOperationPorts(environment);
    const audit = { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' };
    const context = requestContext();

    await ports.statusPort.requestStatusChange({ audit, reason: '违反平台规则', requestContext: context, targetStatus: 'SUSPENDED', trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' });
    expect(new Headers(request?.headers).get('X-Trace-Id')).toBe(context.traceId);
    expect(new Headers(request?.headers).get('X-Correlation-Id')).toBe(context.correlationId);

    const invalidContext = { correlationId: ` ${context.correlationId}`, traceId: context.traceId };
    const callsAfterValidStatus = fetchMock.mock.calls.length;
    await expect(Reflect.apply(ports.statusPort.requestStatusChange.bind(ports.statusPort), undefined, [{ audit, reason: '违反平台规则', requestContext: invalidContext, targetStatus: 'SUSPENDED', trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' }])).rejects.toThrow('Invalid outbound request context');
    await expect(Reflect.apply(ports.adjustmentPort.submitAdjustmentRequest.bind(ports.adjustmentPort), undefined, [{ approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit, direction: 'CREDIT', points: 1n, previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456', reason: '合规补偿', requestContext: invalidContext, trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' }])).rejects.toThrow('Invalid outbound request context');
    await expect(Reflect.apply(ports.exportPort.requestCsvExport.bind(ports.exportPort), undefined, [{ audit, filters: {}, reason: '合规导出', requestContext: invalidContext, scope: 'ALL', trustedSessionToken: 'trusted-session' }])).rejects.toThrow('Invalid outbound request context');
    expect(fetchMock).toHaveBeenCalledTimes(callsAfterValidStatus);
  });

  it('treats only a 202 request/audit receipt as accepted and never returns a final identity status', async () => {
    const receipt = { auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f' };
    const context = requestContext();
    const input = { audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, reason: '违反平台规则', requestContext: context, targetStatus: 'SUSPENDED' as const, trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(receipt, 202)));
    await expect(createHttpUserOperationPorts(environment).statusPort.requestStatusChange(input)).resolves.toEqual(receipt);

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(receipt, 200)));
    await expect(createHttpUserOperationPorts(environment).statusPort.requestStatusChange(input)).rejects.toThrow('Status change denied');

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ auditRecordId: receipt.auditRecordId, status: 'SUSPENDED' }, 202)));
    await expect(createHttpUserOperationPorts(environment).statusPort.requestStatusChange(input)).rejects.toThrow('Invalid status change response');
  });

  it('submits an adjustment request, never a direct wallet mutation, with the trusted session', async () => {
    let requestedUrl = '';
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        requestedUrl = String(url);
        request = init;
        return jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f', status: 'PENDING_APPROVAL' }, 202);
      }),
    );
    const { adjustmentPort } = createHttpUserOperationPorts(environment);

    await adjustmentPort.submitAdjustmentRequest({
      approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f',
      audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' },
      direction: 'DEBIT',
      points: 123n,
      reason: '合规补偿',
      previewToken: 'preview-token-1234',
      requestContext: requestContext(),
      trustedSessionToken: 'trusted-session',
      userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
    });

    expect(requestedUrl).toContain('/v1/admin/users/0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f/wallet-adjustment-requests');
    expect(requestedUrl).not.toContain('/wallet/balance');
    expect(request?.method).toBe('POST');
    expect(new Headers(request?.headers).get('X-Admin-Session-Token')).toBe(
      'trusted-session',
    );
    expect(new Headers(request?.headers).get('X-Trace-Id')).toBe('00112233445566778899aabbccddeeff');
    const submittedBody = request?.body;
    if (typeof submittedBody !== 'string') throw new Error('missing adjustment request body');
    expect(JSON.parse(submittedBody)).toMatchObject({ direction: 'DEBIT', points: '123' });
    expect(JSON.parse(submittedBody)).not.toHaveProperty('amountMinor');
    expect(request?.redirect).toBe('error');
  });

  it('fails closed for adjustment denial, conflict, and malformed preview responses', async () => {
    for (const status of [401, 403, 409]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, status)));
      const { adjustmentPort } = createHttpUserOperationPorts(environment);
      await expect(adjustmentPort.submitAdjustmentRequest({ approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, direction: 'CREDIT', points: 123n, previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456', reason: '合规补偿', trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow();
    }
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ before: '1' })));
    const { adjustmentPort } = createHttpUserOperationPorts(environment);
    await expect(adjustmentPort.previewAdjustment?.({ approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, direction: 'CREDIT', points: 123n, reason: '合规补偿', trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow('Invalid wallet adjustment preview');
  });

  it('sends the stable preview UUIDv7 as idempotency key with an independent trace and exact huge points', async () => {
    let request: RequestInit | undefined;
    const hugePoints = 900719925474099312345678901234567890n;
    vi.stubGlobal('fetch', vi.fn(async (_url: URL, init?: RequestInit) => {
      request = init;
      return jsonResponse({ after: hugePoints.toString(), before: '0', direction: 'CREDIT', expiresAt: '2026-09-03T09:00:00.000Z', impact: 'ledger', points: hugePoints.toString(), policy: 'two-person', previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456' });
    }));
    const { adjustmentPort } = createHttpUserOperationPorts(environment);

    await expect(adjustmentPort.previewAdjustment?.({ approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, direction: 'CREDIT', points: hugePoints, reason: '合规补偿', requestContext: requestContext(), trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).resolves.toMatchObject({ direction: 'CREDIT', points: hugePoints.toString() });
    const headers = new Headers(request?.headers);
    expect(headers.get('Idempotency-Key')).toBe('0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
    expect(headers.get('X-Trace-Id')).toBe('00112233445566778899aabbccddeeff');
    expect(headers.get('Idempotency-Key')).not.toBe(headers.get('X-Trace-Id'));
    const requestBody = request?.body;
    if (typeof requestBody !== 'string') throw new Error('missing adjustment preview body');
    const body = JSON.parse(requestBody) as Record<string, unknown>;
    expect(body).toMatchObject({ direction: 'CREDIT', points: hugePoints.toString() });
    expect(body).not.toHaveProperty('amountMinor');
    expect(body).not.toHaveProperty('delta');
  });

  it.each([
    ['fractional before', { before: '1.5' }],
    ['negative after', { after: '-1' }],
    ['leading-zero points', { points: '01' }],
    ['signed points', { points: '+1' }],
    ['exponent points', { points: '1e3' }],
    ['invalid direction', { direction: 'TRANSFER' }],
    ['offset expiry', { expiresAt: '2026-09-03T17:00:00+08:00' }],
    ['expiry without Z', { expiresAt: '2026-09-03T09:00:00' }],
    ['rolled expiry', { expiresAt: '2026-02-30T09:00:00Z' }],
  ])('rejects malformed authoritative preview scalar: %s', async (_name, override) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ after: '2', before: '1', direction: 'CREDIT', expiresAt: '2026-09-03T09:00:00.000Z', impact: 'ledger', points: '1', policy: 'two-person', previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456', ...override })));
    const { adjustmentPort } = createHttpUserOperationPorts(environment);
    await expect(adjustmentPort.previewAdjustment?.({ approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, direction: 'CREDIT', points: 1n, reason: '合规补偿', trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow('Invalid wallet adjustment preview');
  });

  it.each([
    ['credit arithmetic mismatch', { after: '109', before: '100', direction: 'CREDIT', points: '10' }],
    ['debit arithmetic mismatch', { after: '91', before: '100', direction: 'DEBIT', points: '10' }],
    ['debit underflow disguised as zero', { after: '0', before: '5', direction: 'DEBIT', points: '10' }],
  ])('rejects syntactically valid but incoherent authoritative preview: %s', async (_name, values) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...values, expiresAt: '2026-09-03T09:00:00.000Z', impact: 'ledger', policy: 'two-person', previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456' })));
    const { adjustmentPort } = createHttpUserOperationPorts(environment);
    await expect(adjustmentPort.previewAdjustment?.({ approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, direction: values.direction as 'CREDIT' | 'DEBIT', points: 10n, reason: '合规补偿', trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow('Invalid wallet adjustment preview');
  });

  it('rejects malformed adjustment request receipts', async () => {
    for (const payload of [{ auditRecordId: 'audit-1', requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f', status: 'APPROVED' }, { auditRecordId: 'a'.repeat(129), requestId: '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f', status: 'PENDING_APPROVAL' }, {}]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload, 202)));
      const { adjustmentPort } = createHttpUserOperationPorts(environment);
      await expect(adjustmentPort.submitAdjustmentRequest({ approverId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f', audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, direction: 'CREDIT', points: 1n, previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456', reason: '合规补偿', trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toThrow('Invalid wallet adjustment request');
    }
  });

  it('requests audited CSV export through the service boundary without returning a URL', async () => {
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: URL, init?: RequestInit) => {
        request = init;
        return jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://download.example.invalid/export', expiresAt: new Date(Date.now() + 60_000).toISOString() }, 202);
      }),
    );
    const { exportPort } = createHttpUserOperationPorts(environment);

    await expect(
      exportPort.requestCsvExport({
        audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' },
        filters: { status: 'ACTIVE', tag: 'vip' },
        query: 'member',
        reason: '月度合规核对',
        requestContext: requestContext(),
        scope: 'ALL',
        trustedSessionToken: 'trusted-session',
      }),
    ).resolves.toMatchObject({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://download.example.invalid/export' });
    expect(new Headers(request?.headers).get('X-Admin-Session-Token')).toBe(
      'trusted-session',
    );
    expect(new Headers(request?.headers).get('Idempotency-Key')).toBe('0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f');
    expect(new Headers(request?.headers).get('X-Trace-Id')).toBe('00112233445566778899aabbccddeeff');
    const body = request?.body;
    expect(typeof body).toBe('string');
    if (typeof body !== 'string') throw new Error('missing export request body');
    expect(JSON.parse(body)).toMatchObject({ query: 'member', reason: '月度合规核对', scope: 'ALL' });
    expect(body).not.toContain('exactPhone');
    expect(request?.body).toContain('"status":"ACTIVE"');
  });

  it('exports an exact-phone result using only its raw opaque handle', async () => {
    let request: RequestInit | undefined;
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      request = init;
      return jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://download.example.invalid/export', expiresAt: new Date(Date.now() + 60_000).toISOString() }, 202);
    });
    const port = createHttpUserOperationPorts(environment, { fetchImpl: fetchMock }).exportPort;
    await port.requestCsvExport({ audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, reason: '精确结果导出', searchHandle: 'opaque_Search-Handle_1234', scope: 'ALL', trustedSessionToken: 'trusted-session' });
    const requestBody = request?.body;
    if (typeof requestBody !== 'string') throw new Error('missing exact export request body');
    expect(JSON.parse(requestBody)).toEqual({ reason: '精确结果导出', searchHandle: 'opaque_Search-Handle_1234', scope: 'ALL' });
    expect(requestBody).not.toContain('13800138000');
    expect(requestBody).not.toContain('phone');

    await expect(port.requestCsvExport({ audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, reason: '精确结果导出', searchHandle: ' opaque_Search-Handle_1234', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid search handle');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { query: 'member-13800138000' },
    { filters: { tag: '+86 138-0013-8000' } },
  ])('rejects sensitive normal CSV input at the final HTTP boundary', async (input) => {
    const fetchMock = vi.fn(async () => jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://download.example.invalid/export', expiresAt: new Date(Date.now() + 60_000).toISOString() }, 202));
    const port = createHttpUserOperationPorts(environment, { fetchImpl: fetchMock }).exportPort;
    await expect(port.requestCsvExport({ ...input, audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, reason: '合规导出', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow(/sensitive/iu);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['2026-09-03T17:00:00+08:00', '2026-09-03T09:00:00', '2026-02-30T09:00:00Z'])(
    'rejects malformed authoritative CSV expiry %s',
    async (expiresAt) => {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://download.example.invalid/export', expiresAt }, 202)));
      await expect(createHttpUserOperationPorts(environment).exportPort.requestCsvExport({ audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, reason: '月度合规核对', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid CSV export audit response');
    },
  );

  it.each([
    'https://download.example.invalid/export/13800138000.csv',
    'https://download.example.invalid/export?member=%2B86%20138-0013-8000',
    'https://download.example.invalid/export?member=%252B86%2520138-0013-8000',
    'https://download.example.invalid/export/%D9%A1%D9%A3%D9%A8%D9%A0%D9%A0%D9%A1%D9%A3%D9%A8%D9%A0%D9%A0%D9%A0.csv',
    'https://download.example.invalid/export?member=138%0A0013%0D8000',
    'https://download.example.invalid/export/member-138%00%30%30%31%33%38%30%30%30.csv',
  ])('rejects a phone-like CSV download URL before it can reach the client: %s', async (downloadUrl) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl, expiresAt: new Date(Date.now() + 60_000).toISOString() }, 202)));
    await expect(createHttpUserOperationPorts(environment).exportPort.requestCsvExport({ audit: { idempotencyKey: '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f' }, reason: '合规核对', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid CSV export audit response');
  });

  it('searches users at the server boundary with a cursor and trusted scope context', async () => {
    let requestedUrl = '';
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        requestedUrl = String(url);
        request = init;
        return jsonResponse({ items: [], nextCursor: null });
      }),
    );
    const { directoryPort } = createHttpUserOperationPorts(environment);

    await expect(
      directoryPort.searchUsers({
        cursor: 'cursor-1',
        filters: { registrationSource: 'WEB', spendingTier: 'HIGH', status: 'ACTIVE', tag: 'vip' },
        query: 'account-9',
        trustedSessionToken: 'trusted-session',
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
    expect(requestedUrl).toContain('cursor=cursor-1');
    expect(requestedUrl).toContain('query=account-9');
    expect(requestedUrl).toContain('status=ACTIVE');
    expect(requestedUrl).toContain('tag=vip');
    expect(requestedUrl).toContain('registrationSource=WEB');
    expect(requestedUrl).toContain('spendingTier=HIGH');
    expect(request?.method).toBe('GET');
    expect(new Headers(request?.headers).get('X-Admin-Session-Token')).toBe(
      'trusted-session',
    );
  });

  it.each(['138/0013/8000', '138,0013,8000', `138\u200b0013\u200b8000`, 'x%ZZ%31%33%38%30%30%31%33%38%30%30%30', '١٣٨٠٠١٣٨٠٠٠', '۱۳۸۰۰۱۳۸۰۰۰', '१३८००१३८०००', '𝟙𝟛𝟠𝟘𝟘𝟙𝟛𝟠𝟘𝟘𝟘', '1٣८０0۱3٨۰0٠'])(
    'rejects robustly detected sensitive directory input before fetch: %s',
    async (query) => {
      const fetchImpl = vi.fn(async () => jsonResponse({ items: [], nextCursor: null }));
      const port = createHttpUserOperationPorts(environment, { fetchImpl }).directoryPort;
      await expect(port.searchUsers({ query, trustedSessionToken: 'trusted-session' })).rejects.toThrow('Sensitive user directory query is forbidden');
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it.each(['增长 100%', '%ZZ普通文本'])('allows non-sensitive percent text in a directory query: %s', async (query) => {
    const fetchImpl = vi.fn(async () => jsonResponse({ items: [], nextCursor: null }));
    const port = createHttpUserOperationPorts(environment, { fetchImpl }).directoryPort;
    await expect(port.searchUsers({ query, trustedSessionToken: 'trusted-session' })).resolves.toEqual({ items: [], nextCursor: null });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it.each([
    { label: 'international phone', row: { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '+8613800138000', status: 'ACTIVE' } },
    { label: 'short phone', row: { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '1380013800', status: 'ACTIVE' } },
    { label: 'random phone', row: { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '13800138000x', status: 'ACTIVE' } },
    { label: 'pending status', row: { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'PENDING' } },
    { label: 'missing status', row: { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000' } },
  ])('rejects a malformed authoritative directory row: $label', async ({ row }) => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [row], nextCursor: null })));
    const { directoryPort } = createHttpUserOperationPorts(environment);
    await expect(directoryPort.searchUsers({ query: '', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid user directory response');
  });

  it.each([
    { displayName: 'member-13800138000' },
    { displayName: '+86 138-0013-8000' },
    { tags: ['vip-１３８００１３８０００'] },
    { displayName: 'member-١٣٨٠٠١٣٨٠٠٠' },
    { displayName: `member-1\u03003800138000` },
    { tags: ['vip-138😀0013🚀8000'] },
    { displayName: `campaign-138\u00000013\ue0008000` },
  ])('rejects phone-like authority text in a directory row: %o', async (override) => {
    const row = { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'ACTIVE', ...override };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [row], nextCursor: null })));
    await expect(createHttpUserOperationPorts(environment).directoryPort.searchUsers({ query: '', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid user directory response');
  });

  it('rejects a phone-like upstream cursor before it reaches the loader or a pagination href', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [], nextCursor: 'cursor_13800138000' })));
    await expect(createHttpUserOperationPorts(environment).directoryPort.searchUsers({ query: '', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid user directory response');
  });

  it('rejects an Nd phone-like upstream cursor and exact handle', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [], nextCursor: 'cursor_١٣٨٠٠١٣٨٠٠٠' })));
    await expect(createHttpUserOperationPorts(environment).directoryPort.searchUsers({ query: '', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid user directory response');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [], searchHandle: 'opaque_١٣٨٠٠١٣٨٠٠٠_handle' })));
    await expect(createHttpUserOperationPorts(environment).exactPhonePort.lookupExactPhone({ phone: '13800138000', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid exact phone lookup response');
  });

  it('rejects mark and symbol separated phone-like cursors and exact handles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [], nextCursor: `cursor_1\u03003800138000` })));
    await expect(createHttpUserOperationPorts(environment).directoryPort.searchUsers({ query: '', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid user directory response');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [], searchHandle: 'opaque_138😀0013🚀8000_handle' })));
    await expect(createHttpUserOperationPorts(environment).exactPhonePort.lookupExactPhone({ phone: '13800138000', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid exact phone lookup response');
  });

  it('rejects control/private-use separated phone-like cursors and exact handles', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [], nextCursor: `cursor_138\u00000013\ue0008000` })));
    await expect(createHttpUserOperationPorts(environment).directoryPort.searchUsers({ query: '', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid user directory response');
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [], searchHandle: `opaque_138\n0013\r8000_handle` })));
    await expect(createHttpUserOperationPorts(environment).exactPhonePort.lookupExactPhone({ phone: '13800138000', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid exact phone lookup response');
  });

  it('rejects a phone-like exact search handle before descriptor signing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ expiresAt: new Date(Date.now() + 60_000).toISOString(), items: [], searchHandle: 'opaque_13800138000_handle' })));
    await expect(createHttpUserOperationPorts(environment).exactPhonePort.lookupExactPhone({ phone: '13800138000', scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid exact phone lookup response');
  });

  it('returns only a strict upstream mask and rejects plaintext fields', async () => {
    const maskedRow = { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'ACTIVE' };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [maskedRow], nextCursor: null })));
    const searchInput = { query: '', trustedSessionToken: 'trusted-session' };
    await expect(createHttpUserOperationPorts(environment).directoryPort.searchUsers(searchInput)).resolves.toEqual({ items: [maskedRow], nextCursor: null });

    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ items: [{ ...maskedRow, phone: '13800138000' }], nextCursor: null })));
    await expect(createHttpUserOperationPorts(environment).directoryPort.searchUsers(searchInput)).rejects.toThrow('Invalid user directory response');
  });

  it.each(['+8613800138000', '1380013800', '13800138000x', 'not-a-phone'])(
    'rejects an authorized but malformed exact-phone HTTP query %s before fetch',
    async (query) => {
      let calls = 0;
      vi.stubGlobal('fetch', vi.fn(async () => { calls += 1; return jsonResponse({ items: [], nextCursor: null }); }));
      const { exactPhonePort } = createHttpUserOperationPorts(environment);
      await expect(exactPhonePort.lookupExactPhone({ phone: query, scope: 'ALL', trustedSessionToken: 'trusted-session' })).rejects.toThrow('Invalid exact phone lookup');
      expect(calls).toBe(0);
    },
  );

  it('reads an authoritative server-authorized detail view with the trusted session and a deadline', async () => {
    let requestedUrl = '';
    let request: RequestInit | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL, init?: RequestInit) => {
        requestedUrl = String(url);
        request = init;
        return jsonResponse(validAuthoritativeDetail());
      }),
    );
    const { detailPort } = createHttpUserOperationPorts(environment);

    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).resolves.toMatchObject({ user: { displayName: '用户' } });
    expect(requestedUrl).toContain('/v1/admin/users/0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f/detail');
    expect(new Headers(request?.headers).get('X-Admin-Session-Token')).toBe('trusted-session');
    expect(request?.redirect).toBe('error');
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it('accepts a case-only UUIDv7 difference when binding a detail response to its request', async () => {
    const payload = validAuthoritativeDetail();
    payload.user.id = payload.user.id.toUpperCase();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const result = await createHttpUserOperationPorts(environment).detailPort.getUserDetail({ trustedSessionToken: 'trusted-session', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' });
    expect(result.user.id).toBe('0198F7A4-C6D1-7B39-8A4E-73AF0C1D2E3F');
  });

  it('accepts an explicit authoritative denied-tab complement and rejects missing, overlapping, or unknown markers', async () => {
    const denied = validAuthoritativeDetail();
    denied.tabs = denied.tabs.slice(0, 1);
    denied.deniedTabs = ['tasks', 'wallet', 'orders', 'tickets', 'audit'];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(denied)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).resolves.toMatchObject({ deniedTabs: denied.deniedTabs, tabs: [{ id: 'account' }] });
    for (const deniedTabs of [[], ['account', 'tasks', 'wallet', 'orders', 'tickets', 'audit'], ['tasks', 'wallet', 'orders', 'tickets', 'unknown']]) {
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ...denied, deniedTabs })));
      await expect(createHttpUserOperationPorts(environment).detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
    }
  });

  it('rejects a wallet-adjustment capability when the authoritative wallet tab is denied', async () => {
    const payload = validAuthoritativeDetail();
    payload.tabs.splice(2, 1);
    payload.deniedTabs = ['wallet'];
    payload.canRequestWalletAdjustment = true;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));

    await expect(createHttpUserOperationPorts(environment).detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it.each([
    ['offset account timestamp', (payload: MutableDetail) => { (payload.tabs[0] as { account: { createdAt: string } }).account.createdAt = '2026-08-31T16:00:00+08:00'; }],
    ['session timestamp without Z', (payload: MutableDetail) => { (payload.tabs[0] as { session: { lastActiveAt: string } }).session.lastActiveAt = '2026-08-31T08:00:00'; }],
    ['rolled device date', (payload: MutableDetail) => { const account = payload.tabs[0] as unknown as { session: { devices: Array<{ lastSeenAt: string }> } }; const [device] = account.session.devices; if (!device) throw new Error('missing device fixture'); device.lastSeenAt = '2026-02-30T08:00:00Z'; }],
    ['offset login timestamp', (payload: MutableDetail) => { const account = payload.tabs[0] as unknown as { session: { loginRecords: Array<{ occurredAt: string }> } }; const [login] = account.session.loginRecords; if (!login) throw new Error('missing login fixture'); login.occurredAt = '2026-08-31T16:00:00+08:00'; }],
    ['invalid task date', (payload: MutableDetail) => { firstRecord(payload, 'tasks', 'items').createdAt = '2026-02-30T08:00:00Z'; }],
    ['order timestamp without Z', (payload: MutableDetail) => { firstRecord(payload, 'orders', 'items').createdAt = '2026-08-31T08:00:00'; }],
    ['offset ticket timestamp', (payload: MutableDetail) => { firstRecord(payload, 'tickets', 'items').createdAt = '2026-08-31T16:00:00+08:00'; }],
    ['audit timestamp without Z', (payload: MutableDetail) => { firstRecord(payload, 'audit', 'items').occurredAt = '2026-08-31T08:00:00'; }],
    ['offset recharge timestamp', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'rechargeHistory').occurredAt = '2026-08-31T16:00:00+08:00'; }],
    ['rolled consumption timestamp', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'consumptionHistory').occurredAt = '2026-02-30T08:00:00Z'; }],
    ['adjustment timestamp without Z', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'adjustmentHistory').occurredAt = '2026-08-31T08:00:00'; }],
    ['leading-zero wallet balance', (payload: MutableDetail) => { (payload.tabs[2] as { balance: string }).balance = '01'; }],
    ['fractional frozen points', (payload: MutableDetail) => { (payload.tabs[2] as { frozenBalance: string }).frozenBalance = '1.5'; }],
    ['negative recharge points', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'rechargeHistory').points = '-1'; }],
    ['exponent consumption points', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'consumptionHistory').points = '1e3'; }],
    ['signed adjustment points', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'adjustmentHistory').points = '+1'; }],
    ['missing recharge direction', (payload: MutableDetail) => { delete firstRecord(payload, 'wallet', 'rechargeHistory').direction; }],
    ['inconsistent recharge direction', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'rechargeHistory').direction = 'DEBIT'; }],
    ['missing consumption direction', (payload: MutableDetail) => { delete firstRecord(payload, 'wallet', 'consumptionHistory').direction; }],
    ['inconsistent consumption direction', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'consumptionHistory').direction = 'CREDIT'; }],
    ['missing adjustment direction', (payload: MutableDetail) => { delete firstRecord(payload, 'wallet', 'adjustmentHistory').direction; }],
    ['unknown adjustment direction', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'adjustmentHistory').direction = 'TRANSFER'; }],
  ])('rejects malformed authoritative detail scalar: %s', async (_name, mutate) => {
    const payload = validAuthoritativeDetail(); mutate(payload);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    await expect(createHttpUserOperationPorts(environment).detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it.each([
    ['top display name', (payload: MutableDetail) => { payload.user.displayName = 'member-13800138000'; }],
    ['account tag', (payload: MutableDetail) => { const tag = (payload.tabs[0] as unknown as { account: { tags: Array<{ value: string }> } }).account.tags[0]; if (!tag) throw new Error('missing tag'); tag.value = '+86 138-0013-8000'; }],
    ['device platform', (payload: MutableDetail) => { const device = (payload.tabs[0] as unknown as { session: { devices: Array<{ platform: string }> } }).session.devices[0]; if (!device) throw new Error('missing device'); device.platform = 'iOS-１３８００１３８０００'; }],
    ['login device label', (payload: MutableDetail) => { const record = (payload.tabs[0] as unknown as { session: { loginRecords: Array<{ deviceLabel: string }> } }).session.loginRecords[0]; if (!record) throw new Error('missing login record'); record.deviceLabel = 'phone-13800138000'; }],
    ['wallet status', (payload: MutableDetail) => { firstRecord(payload, 'wallet', 'rechargeHistory').status = 'SETTLED-13800138000'; }],
    ['audit action', (payload: MutableDetail) => { firstRecord(payload, 'audit', 'items').action = 'VIEWED-13800138000'; }],
    ['approver display name', (payload: MutableDetail) => { const approver = payload.eligibleApprovers[0]; if (!approver) throw new Error('missing approver'); approver.displayName = '管理员-13800138000'; }],
    ['Unicode Nd audit action', (payload: MutableDetail) => { firstRecord(payload, 'audit', 'items').action = 'VIEWED-١٣٨٠٠١٣٨٠٠٠'; }],
    ['combining-mark audit action', (payload: MutableDetail) => { firstRecord(payload, 'audit', 'items').action = `VIEWED-1\u03003800138000`; }],
    ['emoji-separated device label', (payload: MutableDetail) => { const record = (payload.tabs[0] as unknown as { session: { loginRecords: Array<{ deviceLabel: string }> } }).session.loginRecords[0]; if (!record) throw new Error('missing login record'); record.deviceLabel = 'phone-138😀0013🚀8000'; }],
    ['control/private-use audit action', (payload: MutableDetail) => { firstRecord(payload, 'audit', 'items').action = `VIEWED-138\u00000013\ue0008000`; }],
  ])('rejects phone-like renderable detail authority text: %s', async (_name, mutate) => {
    const payload = validAuthoritativeDetail(); mutate(payload);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    await expect(createHttpUserOperationPorts(environment).detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it('preserves huge integer points in every authoritative wallet field without Number coercion', async () => {
    const huge = '900719925474099312345678901234567890';
    const payload = validAuthoritativeDetail();
    const wallet = payload.tabs[2] as unknown as { adjustmentHistory: Array<Record<string, unknown>>; balance: string; consumptionHistory: Array<Record<string, unknown>>; frozenBalance: string; rechargeHistory: Array<Record<string, unknown>> };
    wallet.balance = huge; wallet.frozenBalance = huge;
    const [recharge] = wallet.rechargeHistory; const [consumption] = wallet.consumptionHistory; const [adjustment] = wallet.adjustmentHistory;
    if (!recharge || !consumption || !adjustment) throw new Error('missing wallet history fixture');
    recharge.points = huge; consumption.points = huge; adjustment.points = huge;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const result = await createHttpUserOperationPorts(environment).detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' });
    const resultWallet = result.tabs.find((tab) => tab.id === 'wallet');
    expect(resultWallet?.balance).toBe(huge);
    expect(resultWallet?.frozenBalance).toBe(huge);
  });

  it.each([
    ['device', (payload: MutableDetail, id: string) => { const account = payload.tabs[0] as unknown as { session: { devices: Array<Record<string, unknown>> } }; const [device] = account.session.devices; if (!device) throw new Error('missing account device'); device.id = id; }],
    ['login', (payload: MutableDetail, id: string) => { const account = payload.tabs[0] as unknown as { session: { loginRecords: Array<Record<string, unknown>> } }; const [login] = account.session.loginRecords; if (!login) throw new Error('missing account login'); login.id = id; }],
    ['task', (payload: MutableDetail, id: string) => { firstRecord(payload, 'tasks', 'items').id = id; }],
    ['order', (payload: MutableDetail, id: string) => { firstRecord(payload, 'orders', 'items').id = id; }],
    ['ticket', (payload: MutableDetail, id: string) => { firstRecord(payload, 'tickets', 'items').id = id; }],
    ['recharge', (payload: MutableDetail, id: string) => { firstRecord(payload, 'wallet', 'rechargeHistory').id = id; }],
    ['consumption', (payload: MutableDetail, id: string) => { firstRecord(payload, 'wallet', 'consumptionHistory').id = id; }],
    ['adjustment', (payload: MutableDetail, id: string) => { firstRecord(payload, 'wallet', 'adjustmentHistory').id = id; }],
    ['audit', (payload: MutableDetail, id: string) => { firstRecord(payload, 'audit', 'items').id = id; }],
  ])('rejects UUIDv4 and arbitrary %s identifiers at the detail boundary', async (_family, mutate) => {
    for (const invalidId of ['550e8400-e29b-41d4-a716-446655440000', 'arbitrary-id']) {
      const payload = validAuthoritativeDetail(); mutate(payload, invalidId);
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const { detailPort } = createHttpUserOperationPorts(environment);
      await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
    }
  });

  it('preserves an authoritative detail scope denial and records no sensitive session data', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({}, 403)));
    const { detailPort } = createHttpUserOperationPorts(environment, { telemetry: capture.telemetry });

    await expect(detailPort.getUserDetail({ trustedSessionToken: 'sensitive-session-token', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expectSingleTelemetry(capture.events, 'operations.user.detail-read', 'DOWNSTREAM_DENIED');
    expect(JSON.stringify(capture.events)).not.toContain('sensitive-session-token');
  });

  it('fails closed when a detail response identity differs from the requested user', async () => {
    const capture = telemetryCapture();
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ canRequestWalletAdjustment: false, tabs: [], user: { displayName: '用户', id: '0198f7a4-c6d0-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'ACTIVE' } })));
    const { detailPort } = createHttpUserOperationPorts(environment, { telemetry: capture.telemetry });
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
    expectSingleTelemetry(capture.events, 'operations.user.detail-read', 'MALFORMED_RESPONSE');
  });

  it('fails closed when account identity does not exactly match top-level identity', async () => {
    const payload = validAuthoritativeDetail();
    (payload.tabs[0] as { account: { displayName: string } }).account.displayName = '另一个用户';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it('rejects a detail response that omits an operational tab', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ canRequestWalletAdjustment: false, tabs: [], user: { displayName: '用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'ACTIVE' } })));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it.each([
    (payload: ReturnType<typeof validAuthoritativeDetail>) => { payload.tabs.splice(1, 1); },
    (payload: ReturnType<typeof validAuthoritativeDetail>) => { const duplicate = payload.tabs[1]; if (!duplicate) throw new Error('missing task fixture'); payload.tabs[5] = { ...duplicate }; },
    (payload: ReturnType<typeof validAuthoritativeDetail>) => { payload.tabs[5] = { id: 'unknown', items: [], status: 'EMPTY' }; },
      (payload: ReturnType<typeof validAuthoritativeDetail>) => { (payload.tabs[2] as { rechargeHistory: unknown[] }).rechargeHistory = Array.from({ length: 101 }, (_, index) => ({ direction: 'CREDIT', id: `recharge-${String(index)}`, occurredAt: '2026-08-31T08:00:00.000Z', points: '1', status: 'SETTLED' })); },
  ])('rejects missing, duplicate, unknown, or oversized detail tab content', async (mutate) => {
    const payload = validAuthoritativeDetail();
    mutate(payload);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it.each([
    (payload: ReturnType<typeof validAuthoritativeDetail>) => { payload.allowedStatusTransitions = ['ACTIVE']; },
    (payload: ReturnType<typeof validAuthoritativeDetail>) => { payload.allowedStatusTransitions = ['SUSPENDED', 'ACTIVE']; },
    (payload: ReturnType<typeof validAuthoritativeDetail>) => { payload.user.status = 'UNKNOWN'; (payload.tabs[0] as { account: { status: string } }).account.status = 'UNKNOWN'; payload.allowedStatusTransitions = []; },
    (payload: ReturnType<typeof validAuthoritativeDetail>) => { payload.eligibleApprovers = [{ displayName: '复核管理员', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }, { displayName: '重复', id: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' }]; },
    (payload: ReturnType<typeof validAuthoritativeDetail>) => { payload.eligibleApprovers = [{ displayName: '无效', id: 'bad id' }]; },
  ])('rejects incompatible status capability and malformed eligible approvers', async (mutate) => {
    const payload = validAuthoritativeDetail();
    mutate(payload);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it('accepts CLOSED as an authoritative terminal identity status with no transition', async () => {
    const payload = validAuthoritativeDetail();
    payload.user.status = 'CLOSED';
    (payload.tabs[0] as { account: { status: string } }).account.status = 'CLOSED';
    payload.allowedStatusTransitions = [];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    const result = await detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' });
    expect(result.tabs.find((tab) => tab.id === 'account')).toMatchObject({ account: { status: 'CLOSED' } });
  });

  it.each(['ACTIVE', 'SUSPENDED'] as const)('accepts an authoritative denial of the %s status transition', async (status) => {
    const payload = validAuthoritativeDetail();
    payload.user.status = status;
    (payload.tabs[0] as { account: { status: string } }).account.status = status;
    payload.allowedStatusTransitions = [];
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).resolves.toBeDefined();
  });

  it('requires strict masked-only phone identity and binds top-level status to the account', async () => {
    const payload = validAuthoritativeDetail();
    const account = (payload.tabs[0] as { account: Record<string, unknown> }).account;
    const user = payload.user as unknown as Record<string, unknown>;
    user.phoneMasked = '138****8000';
    user.status = 'ACTIVE';
    account.phoneMasked = '138****8000';
    delete user.phone;
    delete account.phone;
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).resolves.toMatchObject({ user: { phoneMasked: '138****8000', status: 'ACTIVE' } });

    user.status = 'SUSPENDED';
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it('rejects plaintext phone fields even when their masked counterpart is present', async () => {
    const payload = validAuthoritativeDetail();
    const account = (payload.tabs[0] as { account: Record<string, unknown> }).account;
    const user = payload.user as unknown as Record<string, unknown>;
    user.phoneMasked = '138****8000';
    user.status = 'ACTIVE';
    account.phoneMasked = '138****8000';
    user.phone = '13800138000';
    account.phone = '13800138000';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it.each([
    { allowed: ['QUOTED', 'RESERVED', 'QUEUED', 'SUBMITTING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED', 'EXPIRED', 'SETTLED', 'REFUNDED'], tabId: 'tasks' },
    { allowed: ['PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'FAILED'], tabId: 'orders' },
    { allowed: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'], tabId: 'tickets' },
  ])('accepts the full frozen $tabId status set and rejects arbitrary values', async ({ allowed, tabId }) => {
    for (const status of allowed) {
      const payload = validAuthoritativeDetail();
      firstRecord(payload, tabId, 'items').status = status;
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const { detailPort } = createHttpUserOperationPorts(environment);
      await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).resolves.toBeDefined();
    }
    const payload = validAuthoritativeDetail();
    firstRecord(payload, tabId, 'items').status = 'UNKNOWN';
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });

  it.each(['PENDING', 'UNKNOWN'])(
    'rejects non-contract identity status %s at the detail boundary',
    async (status) => {
      const payload = validAuthoritativeDetail();
      payload.user.status = status;
      (payload.tabs[0] as { account: { status: string } }).account.status = status;
      payload.allowedStatusTransitions = [];
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const { detailPort } = createHttpUserOperationPorts(environment);
      await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
    },
  );

  it.each(['+8613800138000', '1380013800', '13800138000x'])(
    'rejects malformed authoritative detail phone mask %s',
    async (phoneMasked) => {
      const payload = validAuthoritativeDetail();
      payload.user.phoneMasked = phoneMasked;
      (payload.tabs[0] as { account: { phoneMasked: string } }).account.phoneMasked = phoneMasked;
      vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
      const { detailPort } = createHttpUserOperationPorts(environment);
      await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
    },
  );

  it.each([
    [{ unit: 'CNY' }, 'arbitrary unit'],
    [{ unit: undefined }, 'missing unit'],
    [{ currency: 'POINTS' }, 'legacy currency field'],
  ])('rejects wallet %s', async (override, description) => {
    expect(description).not.toHaveLength(0);
    const payload = validAuthoritativeDetail();
    const wallet = payload.tabs.find((tab) => tab.id === 'wallet') as unknown as Record<string, unknown>;
    Object.assign(wallet, override);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(payload)));
    const { detailPort } = createHttpUserOperationPorts(environment);
    await expect(detailPort.getUserDetail({ trustedSessionToken: 'trusted', userId: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f' })).rejects.toMatchObject({ code: 'DEPENDENCY' });
  });
});
