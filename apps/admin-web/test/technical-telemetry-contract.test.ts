/* eslint-disable @typescript-eslint/require-await -- fetch fakes model protected upstream attempts. */

import { describe, expect, it } from 'vitest';

import { createHttpAdminAuthPort } from '../lib/http-admin-auth-port';
import { createHttpOverviewPort } from '../lib/http-overview-port';
import { createHttpUserOperationPorts } from '../lib/http-user-operation-port';
import {
  createOutboundRequestContext,
  isOutboundRequestContext,
  parseOutboundRequestContext,
} from '../lib/outbound-request-context';
import { createSafeTelemetryEvent, recordSafeTelemetry } from '../lib/safe-telemetry';

const correlationId = '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f';
const traceId = '0123456789abcdef0123456789abcdef';
const requestContext = createOutboundRequestContext(() => traceId, () => correlationId);
const userId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const approverId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const intentId = '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f';

function captureTelemetry() {
  const events: unknown[] = [];
  return {
    events,
    telemetry: { record(event: unknown) { events.push(event); } },
  };
}

function expectedEvent(operation: string, reason: string) {
  return { ...requestContext, operation, reason };
}

function expectGeneratedContextEvent(event: unknown, operation: string, reason: string): void {
  if (!event || typeof event !== 'object') throw new Error('missing telemetry event');
  const candidate = event as Record<string, unknown>;
  expect(Reflect.ownKeys(candidate).sort()).toEqual(['correlationId', 'operation', 'reason', 'traceId']);
  expect(candidate.operation).toBe(operation);
  expect(candidate.reason).toBe(reason);
  expect(candidate.correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  expect(candidate.traceId).toMatch(/^[0-9a-f]{32}$/u);
}

describe('technical telemetry contract', () => {
  it('accepts only plain, exact, data-property outbound contexts', () => {
    const symbolKey = Symbol('secret');
    const withSymbol = { correlationId, traceId, [symbolKey]: 'must-not-pass' };
    const withNonEnumerable = { correlationId, traceId };
    Object.defineProperty(withNonEnumerable, 'secret', { enumerable: false, value: 'must-not-pass' });
    const inherited = Object.create({ secret: 'must-not-pass' }) as Record<string, unknown>;
    inherited.correlationId = correlationId;
    inherited.traceId = traceId;
    class ContextClass {
      correlationId = correlationId;
      traceId = traceId;
    }
    const throwingGetter = { correlationId } as Record<string, unknown>;
    Object.defineProperty(throwingGetter, 'traceId', {
      enumerable: true,
      get() { throw new Error('secret getter failure'); },
    });
    const throwingProxy = new Proxy({ correlationId, traceId }, {
      ownKeys() { throw new Error('secret proxy failure'); },
    });

    const parsedUppercase = parseOutboundRequestContext({
      correlationId: correlationId.toUpperCase(),
      traceId,
    });
    const nullPrototype = Object.assign(Object.create(null) as object, {
      correlationId,
      traceId,
    });
    const parsedNullPrototype = parseOutboundRequestContext(nullPrototype);

    expect(isOutboundRequestContext(requestContext)).toBe(true);
    expect(isOutboundRequestContext({ correlationId, traceId })).toBe(false);
    expect(isOutboundRequestContext(parsedUppercase)).toBe(true);
    expect(parsedUppercase.correlationId).toBe(correlationId.toUpperCase());
    expect(isOutboundRequestContext(parsedNullPrototype)).toBe(true);
    expect(Object.getPrototypeOf(parsedNullPrototype)).toBe(Object.prototype);
    expect(Object.isFrozen(requestContext)).toBe(true);
    expect(Reflect.ownKeys(requestContext).sort()).toEqual(['correlationId', 'traceId']);
    expect(isOutboundRequestContext({ correlationId, traceId, secret: 'must-not-pass' })).toBe(false);
    expect(isOutboundRequestContext(withSymbol)).toBe(false);
    expect(isOutboundRequestContext(withNonEnumerable)).toBe(false);
    expect(isOutboundRequestContext(inherited)).toBe(false);
    expect(isOutboundRequestContext(new ContextClass())).toBe(false);
    expect(isOutboundRequestContext([correlationId, traceId])).toBe(false);
    expect(() => isOutboundRequestContext(throwingGetter)).not.toThrow();
    expect(isOutboundRequestContext(throwingGetter)).toBe(false);
    expect(() => isOutboundRequestContext(throwingProxy)).not.toThrow();
    expect(isOutboundRequestContext(throwingProxy)).toBe(false);
  });

  it('rejects transparent proxies, including proxies around an issued context', () => {
    const rawProxy = new Proxy({ correlationId, traceId }, {});
    const issuedProxy = new Proxy(requestContext, {});

    expect(isOutboundRequestContext(rawProxy)).toBe(false);
    expect(isOutboundRequestContext(issuedProxy)).toBe(false);
    expect(() => parseOutboundRequestContext(rawProxy)).toThrow('出站请求上下文无效');
    expect(() => parseOutboundRequestContext(issuedProxy)).toThrow('出站请求上下文无效');
  });

  it('rejects a raw same-shape context before overview and user-operation fetch', async () => {
    const capture = captureTelemetry();
    let fetchCount = 0;
    const rawContext = { correlationId, traceId };
    const overview = createHttpOverviewPort(
      { apiUrl: 'https://reporting.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        fetchImpl: async () => { fetchCount += 1; return Response.json(payloadForUnreachableFetch()); },
        telemetry: capture.telemetry,
      },
    );
    const operations = createHttpUserOperationPorts(
      { apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        fetchImpl: async () => { fetchCount += 1; return Response.json({ items: [], nextCursor: null }); },
        telemetry: capture.telemetry,
      },
    );

    await expect(Reflect.apply(overview.getOverview.bind(overview), undefined, [{ requestContext: rawContext, trustedSessionToken: 'session-secret' }])).rejects.toThrow();
    await expect(Reflect.apply(operations.directoryPort.searchUsers.bind(operations.directoryPort), undefined, [{ query: 'member', requestContext: rawContext, trustedSessionToken: 'session-secret' }])).rejects.toThrow();

    expect(fetchCount).toBe(0);
    expect(capture.events).toHaveLength(2);
    expectGeneratedContextEvent(capture.events[0], 'overview.read', 'DOWNSTREAM_DENIED');
    expectGeneratedContextEvent(capture.events[1], 'operations.user.directory-search', 'DOWNSTREAM_DENIED');
  });

  it('rejects an extra-field context before overview fetch and records one standalone event', async () => {
    const capture = captureTelemetry();
    let fetchCount = 0;
    const port = createHttpOverviewPort(
      { apiUrl: 'https://reporting.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        fetchImpl: async () => { fetchCount += 1; return Response.json(payloadForUnreachableFetch()); },
        telemetry: capture.telemetry,
      },
    );
    const aliasedContext = { correlationId, traceId, secret: 'must-not-pass' };

    await expect(Reflect.apply(port.getOverview.bind(port), undefined, [{ requestContext: aliasedContext, trustedSessionToken: 'session-secret' }])).rejects.toThrow();

    expect(fetchCount).toBe(0);
    expect(capture.events).toHaveLength(1);
    expectGeneratedContextEvent(capture.events[0], 'overview.read', 'DOWNSTREAM_DENIED');
    expect(JSON.stringify(capture.events)).not.toContain('must-not-pass');
  });

  it('rejects an extra-field context before user-operation fetch and records one standalone event', async () => {
    const capture = captureTelemetry();
    let fetchCount = 0;
    const ports = createHttpUserOperationPorts(
      { apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        fetchImpl: async () => { fetchCount += 1; return Response.json({ items: [], nextCursor: null }); },
        telemetry: capture.telemetry,
      },
    );
    const aliasedContext = { correlationId, traceId, secret: 'must-not-pass' };

    await expect(Reflect.apply(ports.directoryPort.searchUsers.bind(ports.directoryPort), undefined, [{ query: 'member', requestContext: aliasedContext, trustedSessionToken: 'session-secret' }])).rejects.toThrow();

    expect(fetchCount).toBe(0);
    expect(capture.events).toHaveLength(1);
    expectGeneratedContextEvent(capture.events[0], 'operations.user.directory-search', 'DOWNSTREAM_DENIED');
    expect(JSON.stringify(capture.events)).not.toContain('must-not-pass');
  });

  it('rejects an extra-field injected IAM context before fetch and records one standalone event', async () => {
    const capture = captureTelemetry();
    let fetchCount = 0;
    const port = createHttpAdminAuthPort(
      { apiUrl: 'https://iam.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        createRequestContext: () => ({ correlationId, traceId, secret: 'must-not-pass' }),
        fetchImpl: async () => { fetchCount += 1; return Response.json({}); },
        telemetry: capture.telemetry,
      },
    );

    await port.beginPasswordChallenge({ correlationId, idempotencyKey: userId, identifier: 'admin', password: 'secret' });

    expect(fetchCount).toBe(0);
    expect(capture.events).toHaveLength(1);
    expectGeneratedContextEvent(capture.events[0], 'iam.password.begin', 'UPSTREAM_FAILURE');
    expect(JSON.stringify(capture.events)).not.toContain('must-not-pass');
  });

  it('never spreads an invalid context into a safe telemetry event', () => {
    const aliasedContext = { correlationId, traceId, secret: 'must-not-pass' };
    expect(() => {
      Reflect.apply(createSafeTelemetryEvent, undefined, ['overview.read', 'UPSTREAM_FAILURE', aliasedContext]);
    }).toThrow();
  });

  it('allows only issued frozen events to reach a telemetry sink', () => {
    const capture = captureTelemetry();
    const event = createSafeTelemetryEvent('overview.read', 'UPSTREAM_FAILURE', requestContext);
    const rawEvent = { correlationId, operation: 'overview.read', reason: 'UPSTREAM_FAILURE', traceId };
    const brandedClone = Object.assign({}, event, { secret: 'must-not-pass' });
    let ownKeysReads = 0;
    const statefulCloneProxy = new Proxy(brandedClone, {
      ownKeys(target) {
        ownKeysReads += 1;
        return ownKeysReads === 1
          ? Reflect.ownKeys(target).filter((key) => key !== 'secret')
          : Reflect.ownKeys(target);
      },
    });
    const issuedEventProxy = new Proxy(event, {});

    expect(Object.isFrozen(event)).toBe(true);
    expect(Reflect.ownKeys(event).sort()).toEqual(['correlationId', 'operation', 'reason', 'traceId']);
    expect(() => {
      Reflect.apply(recordSafeTelemetry, undefined, [capture.telemetry, rawEvent]);
    }).toThrow('Invalid safe telemetry event');
    expect(() => {
      Reflect.apply(recordSafeTelemetry, undefined, [capture.telemetry, issuedEventProxy]);
    }).toThrow('Invalid safe telemetry event');
    expect(() => {
      recordSafeTelemetry(capture.telemetry, statefulCloneProxy);
    }).toThrow('Invalid safe telemetry event');
    expect(ownKeysReads).toBe(0);
    expect(capture.events).toEqual([]);

    recordSafeTelemetry(capture.telemetry, event);
    expect(capture.events).toEqual([event]);
    expect(JSON.stringify(capture.events)).not.toContain('must-not-pass');
  });

  it('uses a safely projected event when an unstable context accompanies a denied user operation', async () => {
    const capture = captureTelemetry();
    let ownKeysReads = 0;
    const unstableContext = new Proxy({ correlationId, traceId }, {
      ownKeys(target) {
        ownKeysReads += 1;
        if (ownKeysReads > 1) throw new Error('secret proxy failure');
        return Reflect.ownKeys(target);
      },
    });
    let fetchCount = 0;
    const ports = createHttpUserOperationPorts(
      { apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        fetchImpl: async () => { fetchCount += 1; return Response.json({}); },
        telemetry: capture.telemetry,
      },
    );

    await expect(Reflect.apply(ports.detailPort.getUserDetail, ports.detailPort, [{ requestContext: unstableContext, trustedSessionToken: 'session-secret', userId: 'invalid-user-id' }])).rejects.not.toThrow('Invalid safe telemetry event');

    expect(fetchCount).toBe(0);
    expect(capture.events).toHaveLength(1);
    expectGeneratedContextEvent(capture.events[0], 'operations.user.detail-read', 'DOWNSTREAM_DENIED');
  });

  it.each([
    { correlationId: requestContext.correlationId, operation: 'overview.read', reason: 'UPSTREAM_FAILURE' },
    { ...requestContext, operation: 'overview.read', reason: 'UPSTREAM_FAILURE', secret: 'must-not-pass' },
    { ...requestContext, traceId: 'ABC', operation: 'overview.read', reason: 'UPSTREAM_FAILURE' },
    { ...requestContext, correlationId: 'not-v7', operation: 'overview.read', reason: 'UPSTREAM_FAILURE' },
  ])('rejects missing, invalid, or non-allowlisted telemetry payload %#', (event) => {
    const capture = captureTelemetry();
    expect(() => { recordSafeTelemetry(capture.telemetry, event as never); }).toThrow('Invalid safe telemetry event');
    expect(capture.events).toEqual([]);
  });

  it.each([
    ['malformed JSON', async () => new Response('{', { status: 200 }), 'MALFORMED_RESPONSE'],
    ['malformed schema', async () => Response.json({ datasets: [] }), 'MALFORMED_RESPONSE'],
    ['429', async () => Response.json({}, { status: 429 }), 'UPSTREAM_FAILURE'],
    ['500', async () => Response.json({}, { status: 500 }), 'UPSTREAM_FAILURE'],
    ['network', async () => Promise.reject(new Error('offline')), 'NETWORK_FAILURE'],
    ['timeout', async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('timed out', 'AbortError')); });
    }), 'TIMEOUT'],
  ])('records one context-bound overview event for %s', async (_label, response, reason) => {
    const requests: Headers[] = [];
    const capture = captureTelemetry();
    const port = createHttpOverviewPort(
      { apiUrl: 'https://reporting.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        deadlineMs: 1,
        fetchImpl: async (input, init) => {
          requests.push(new Headers(init?.headers));
          return response(input, init);
        },
        telemetry: capture.telemetry,
      },
    );

    await expect(port.getOverview({ requestContext, trustedSessionToken: 'session-secret' })).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(capture.events).toEqual([expectedEvent('overview.read', reason)]);
    expect(capture.events).toEqual([{
      correlationId: requests[0]?.get('X-Correlation-Id'),
      operation: 'overview.read',
      reason,
      traceId: requests[0]?.get('X-Trace-Id'),
    }]);
    expect(JSON.stringify(capture.events)).not.toMatch(/session-secret|offline/u);
  });

  it.each([
    ['exact phone', 'operations.user.exact-phone-lookup', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.exactPhonePort.lookupExactPhone({ phone: '13800138000', scope: 'ALL', requestContext, trustedSessionToken: 'session-secret' })],
    ['detail', 'operations.user.detail-read', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.detailPort.getUserDetail({ requestContext, trustedSessionToken: 'session-secret', userId })],
    ['scope', 'operations.scope.read', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.scopePort.getUserScope({ requestContext, trustedSessionToken: 'session-secret', userId })],
    ['status', 'operations.user.status-change', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.statusPort.requestStatusChange({ audit: { idempotencyKey: intentId }, reason: 'manual review', requestContext, targetStatus: 'SUSPENDED', trustedSessionToken: 'session-secret', userId })],
    ['approvers', 'operations.user.eligible-approvers', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.adjustmentPort.getEligibleApprovers({ dataScope: 'ALL', requestContext, trustedSessionToken: 'session-secret', userId })],
    ['preview', 'operations.user.wallet-adjustment-preview', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.adjustmentPort.previewAdjustment?.({ approverId, audit: { idempotencyKey: intentId }, direction: 'CREDIT', points: 1n, reason: 'manual review', requestContext, trustedSessionToken: 'session-secret', userId })],
    ['adjustment', 'operations.user.wallet-adjustment-request', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.adjustmentPort.submitAdjustmentRequest({ approverId, audit: { idempotencyKey: intentId }, direction: 'CREDIT', points: 1n, previewToken: 'pv_abcdefghijklmnopqrstuvwxyz123456', reason: 'manual review', requestContext, trustedSessionToken: 'session-secret', userId })],
    ['CSV', 'operations.user.csv-export', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.exportPort.requestCsvExport({ audit: { idempotencyKey: intentId }, reason: 'manual review', requestContext, scope: 'ALL', trustedSessionToken: 'session-secret' })],
    ['directory', 'operations.user.directory-search', (ports: ReturnType<typeof createHttpUserOperationPorts>) => ports.directoryPort.searchUsers({ query: 'member', requestContext, trustedSessionToken: 'session-secret' })],
  ])('records one malformed-response event for the %s parser', async (_label, operation, invoke) => {
    const requests: Headers[] = [];
    const capture = captureTelemetry();
    const ports = createHttpUserOperationPorts(
      { apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        fetchImpl: async (_input, init) => {
          requests.push(new Headers(init?.headers));
          return Response.json({}, { status: operation === 'operations.user.status-change' ? 202 : 200 });
        },
        telemetry: capture.telemetry,
      },
    );

    await expect(invoke(ports)).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(capture.events).toEqual([expectedEvent(operation, 'MALFORMED_RESPONSE')]);
    expect(capture.events).toEqual([{
      correlationId: requests[0]?.get('X-Correlation-Id'),
      operation,
      reason: 'MALFORMED_RESPONSE',
      traceId: requests[0]?.get('X-Trace-Id'),
    }]);
    expect(JSON.stringify(capture.events)).not.toMatch(/13800138000|session-secret|previewToken|manual review/u);
  });

  it.each([
    ['network', async () => Promise.reject(new Error('offline')), 'NETWORK_FAILURE'],
    ['timeout', async (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { reject(new DOMException('timed out', 'AbortError')); });
    }), 'TIMEOUT'],
    ['429', async () => Response.json({}, { status: 429 }), 'UPSTREAM_FAILURE'],
    ['500', async () => Response.json({}, { status: 500 }), 'UPSTREAM_FAILURE'],
  ])('records one context-bound directory event for %s', async (_label, response, reason) => {
    const requests: Headers[] = [];
    const capture = captureTelemetry();
    const ports = createHttpUserOperationPorts(
      { apiUrl: 'https://operations.example.invalid', kmsIdentityReference: 'kms://service/admin-web' },
      {
        deadlineMs: 1,
        fetchImpl: async (input, init) => {
          requests.push(new Headers(init?.headers));
          return response(input, init);
        },
        telemetry: capture.telemetry,
      },
    );

    await expect(ports.directoryPort.searchUsers({ query: 'member', requestContext, trustedSessionToken: 'session-secret' })).rejects.toThrow();

    expect(capture.events).toEqual([expectedEvent('operations.user.directory-search', reason)]);
    expect(capture.events).toEqual([{
      correlationId: requests[0]?.get('X-Correlation-Id'),
      operation: 'operations.user.directory-search',
      reason,
      traceId: requests[0]?.get('X-Trace-Id'),
    }]);
  });

  it.each([
    ['iam.config', (telemetry: ReturnType<typeof captureTelemetry>['telemetry']) => createHttpAdminAuthPort({ apiUrl: '', kmsIdentityReference: '' }, { telemetry })],
    ['overview.config', (telemetry: ReturnType<typeof captureTelemetry>['telemetry']) => createHttpOverviewPort({ apiUrl: '', kmsIdentityReference: '' }, { telemetry })],
    ['operations.config', (telemetry: ReturnType<typeof captureTelemetry>['telemetry']) => createHttpUserOperationPorts({ apiUrl: '', kmsIdentityReference: '' }, { telemetry })],
  ])('records one standalone context for %s', (operation, construct) => {
    const capture = captureTelemetry();

    expect(() => { construct(capture.telemetry); }).toThrow();

    expect(capture.events).toHaveLength(1);
    expectGeneratedContextEvent(capture.events[0], operation, 'INVALID_CONFIG');
  });
});

function payloadForUnreachableFetch(): object {
  return { datasets: [] };
}
