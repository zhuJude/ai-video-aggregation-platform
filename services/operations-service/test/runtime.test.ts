import { describe, expect, it } from 'vitest';
import { ApiErrorSchema } from '@repo/contracts/common';
import { RechargePackageSchema } from '@repo/contracts/operations';
import { OperationsHttpModule } from '../src/http/operations-http.module.js';
import {
  bootstrapOperationsRuntime,
  OPERATIONS_OPENAPI,
} from '../src/runtime/operations.runtime.js';
import {
  InMemoryPublicationRepository,
  PublicationService,
} from '../src/application/publication.service.js';

describe('Nest operations production runtime', () => {
  it('documents every support route with concrete OpenAPI 3.1 schemas', () => {
    type SupportSchema = {
      additionalProperties?: boolean;
      properties: Record<string, { enum?: string[] }>;
    };
    type SupportOperation = { requestBody?: unknown; responses: Record<string, unknown> };
    const paths = OPERATIONS_OPENAPI.paths as Record<string, Record<string, SupportOperation>>;
    const required: ReadonlyArray<readonly [string, string]> = [
      ['post', '/v1/tickets'],
      ['get', '/v1/tickets'],
      ['get', '/v1/tickets/{id}'],
      ['post', '/v1/tickets/{id}/messages'],
      ['post', '/v1/tickets/{id}/reopen'],
      ['post', '/v1/feedback'],
      ['get', '/v1/feedback'],
      ['get', '/v1/feedback/{id}'],
      ['post', '/admin/v1/tickets/{id}/claim'],
      ['post', '/admin/v1/tickets/{id}/reply'],
      ['post', '/admin/v1/tickets/{id}/internal-notes'],
      ['post', '/admin/v1/tickets/{id}/resolve'],
      ['post', '/admin/v1/tickets/{id}/close'],
    ];
    for (const [method, path] of required) {
      const operation = paths[path]?.[method];
      expect(operation, `${method} ${path}`).toBeDefined();
      expect(operation?.responses).not.toEqual({});
      if (method === 'post') expect(operation?.requestBody).toBeDefined();
    }
    const schemas = OPERATIONS_OPENAPI.components.schemas as unknown as Record<
      string,
      SupportSchema
    >;
    expect(schemas.Ticket?.properties.status?.enum).toEqual([
      'OPEN',
      'IN_PROGRESS',
      'RESOLVED',
      'CLOSED',
    ]);
    expect(schemas.UserTicketView?.properties).not.toHaveProperty('internalNotes');
    expect(schemas.TicketMessageRequest?.additionalProperties).toBe(false);
    expect(schemas.FeedbackRequest?.additionalProperties).toBe(false);
    expect(OPERATIONS_OPENAPI.components.securitySchemes).toEqual({
      bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    });
    expect(
      (paths['/v1/tickets']?.post as SupportOperation & { security?: unknown }).security,
    ).toEqual([{ bearerAuth: [] }]);
  });

  it('publishes validator-like complete OpenAPI 3.1 operations', () => {
    type Schema = { $ref?: string; properties?: Record<string, unknown>; type?: string };
    type Operation = {
      parameters: Array<{ name: string; in: string; required: boolean }>;
      requestBody?: { content: Record<string, { schema: Schema }> };
      responses: Record<string, { content: Record<string, { schema: Schema }> }>;
    };
    const paths = OPERATIONS_OPENAPI.paths as Record<string, Record<string, Operation>>;
    const schemas = OPERATIONS_OPENAPI.components.schemas as Record<string, Schema>;
    const resolve = (schema: Schema | undefined): Schema | undefined =>
      schema?.$ref === undefined ? schema : schemas[schema.$ref.split('/').at(-1) ?? ''];
    for (const [path, item] of Object.entries(paths))
      for (const [method, operation] of Object.entries(item)) {
        for (const name of [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1])) {
          expect(operation.parameters).toContainEqual(
            expect.objectContaining({ name, in: 'path', required: true }),
          );
        }
        if (method === 'post' || method === 'patch')
          expect(
            Object.keys(resolve(operation.requestBody?.content['application/json']?.schema) ?? {}),
          ).not.toHaveLength(0);
        const success = Object.entries(operation.responses).find(([status]) =>
          status.startsWith('2'),
        )?.[1];
        expect(
          Object.keys(resolve(success?.content['application/json']?.schema) ?? {}),
        ).not.toHaveLength(0);
        for (const [status, response] of Object.entries(operation.responses).filter(([status]) =>
          /^[45]/.test(status),
        )) {
          expect(
            response.content['application/json']?.schema.$ref,
            `${method.toUpperCase()} ${path} ${status}`,
          ).toBe('#/components/schemas/ApiError');
        }
      }
    expect(paths['/health/ready']?.get?.responses['200']).toBeDefined();
    expect(
      paths['/health/ready']?.get?.responses['503']?.content['application/json']?.schema.$ref,
    ).toBe('#/components/schemas/ApiError');
    expect(
      paths['/v1/recharge-packages']?.get?.responses['200']?.content['application/json']?.schema
        .$ref,
    ).toBe('#/components/schemas/RechargePackageList');
    const frozenSample = RechargePackageSchema.parse({
      id: '01990f24-2ba2-7000-8000-000000000001',
      name: '100元套餐',
      points: '100000',
      bonusPoints: '5000',
      active: true,
    });
    expect(Object.keys(schemas.RechargePackage?.properties ?? {}).sort()).toEqual(
      Object.keys(frozenSample).sort(),
    );
    expect(
      OPERATIONS_OPENAPI.components.schemas.PackageDraftRequest.properties.currency.enum,
    ).toEqual(['CNY']);
    expect(OPERATIONS_OPENAPI.components.schemas.ApiError.properties.details).toEqual({
      type: 'object',
      additionalProperties: true,
    });
    const idParameter = paths['/admin/v1/recharge-packages/{id}/preview']?.get?.parameters.find(
      (item) => item.name === 'id',
    ) as { schema?: { $ref?: string } };
    expect(idParameter.schema?.$ref).toBe('#/components/schemas/UuidV7');
  });

  it('serves health, OpenAPI 3.1, and frozen ApiError with propagated trace', async () => {
    const http = new OperationsHttpModule({
      publication: new PublicationService({ repository: new InMemoryPublicationRepository() }),
      adminAuthenticator: { authenticate: () => Promise.resolve(null) },
    });
    const runtime = await bootstrapOperationsRuntime({
      http,
      readiness: () => Promise.resolve(true),
      metrics: () => Promise.resolve('support_operations_ticket_backlog{status="open"} 0\n'),
    });
    try {
      expect((await runtime.server.inject({ method: 'GET', url: '/health/live' })).json()).toEqual({
        status: 'ok',
      });
      expect(
        (await runtime.server.inject({ method: 'GET', url: '/openapi.json' })).json(),
      ).toMatchObject({ openapi: '3.1.0' });
      expect((await runtime.server.inject({ method: 'GET', url: '/metrics' })).body).toContain(
        'support_operations_ticket_backlog',
      );
      expect(OPERATIONS_OPENAPI.components.schemas.ApiError.additionalProperties).toBe(false);
      const traceId = '0123456789abcdef0123456789abcdef';
      const denied = await runtime.server.inject({
        method: 'POST',
        url: '/admin/v1/recharge-packages/drafts',
        headers: { 'x-trace-id': traceId },
        payload: {},
      });
      expect(denied.headers['x-trace-id']).toBe(traceId);
      expect(ApiErrorSchema.parse(denied.json())).toMatchObject({
        code: 'UNAUTHENTICATED',
        traceId,
        retryable: false,
      });
    } finally {
      await runtime.close();
    }
  }, 15_000);

  it('uses the required readiness probe and emits frozen ApiError when unavailable', async () => {
    const http = new OperationsHttpModule({
      publication: new PublicationService({ repository: new InMemoryPublicationRepository() }),
      adminAuthenticator: { authenticate: () => Promise.resolve(null) },
    });
    const runtime = await bootstrapOperationsRuntime({
      http,
      readiness: () => Promise.resolve(false),
    });
    try {
      const traceId = 'abcdef0123456789abcdef0123456789';
      const response = await runtime.server.inject({
        method: 'GET',
        url: '/health/ready',
        headers: { 'x-trace-id': traceId },
      });
      expect(response.statusCode).toBe(503);
      expect(ApiErrorSchema.parse(response.json())).toMatchObject({
        code: 'DEPENDENCY_UNAVAILABLE',
        traceId,
        retryable: true,
      });
    } finally {
      await runtime.close();
    }
  });

  it.each([
    ['false', () => Promise.resolve(false)],
    ['throw', () => Promise.reject(new Error('database unavailable'))],
  ])(
    'maps readiness %s without an incoming trace to a random frozen 503 error',
    async (_kind, readiness) => {
      const http = new OperationsHttpModule({
        publication: new PublicationService({ repository: new InMemoryPublicationRepository() }),
        adminAuthenticator: { authenticate: () => Promise.resolve(null) },
      });
      const runtime = await bootstrapOperationsRuntime({ http, readiness });
      try {
        const response = await runtime.server.inject({ method: 'GET', url: '/health/ready' });
        expect(response.statusCode).toBe(503);
        const parsed = ApiErrorSchema.parse(response.json());
        expect(parsed.traceId).toMatch(/^[a-f0-9]{32}$/);
        expect(parsed.traceId).not.toBe('00000000000000000000000000000000');
        expect(response.headers['x-trace-id']).toBe(parsed.traceId);
      } finally {
        await runtime.close();
      }
    },
  );

  it('normalizes framework parser failures to the frozen ApiError shape', async () => {
    const http = new OperationsHttpModule({
      publication: new PublicationService({ repository: new InMemoryPublicationRepository() }),
      adminAuthenticator: { authenticate: () => Promise.resolve(null) },
    });
    const runtime = await bootstrapOperationsRuntime({
      http,
      readiness: () => Promise.resolve(true),
    });
    try {
      const response = await runtime.server.inject({
        method: 'POST',
        url: '/admin/v1/recharge-packages/drafts',
        headers: { 'content-type': 'application/json' },
        payload: '{',
      });
      expect(response.statusCode).toBe(400);
      expect(ApiErrorSchema.safeParse(response.json()).success).toBe(true);
    } finally {
      await runtime.close();
    }
  });
});
