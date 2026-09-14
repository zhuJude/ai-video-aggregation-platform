import { describe, expect, it } from 'vitest';
import { InMemoryPublicationRepository, PublicationService } from '../src/application/publication.service.js';
import { InMemoryTicketRepository, TicketService, type TicketRepository } from '../src/application/ticket.service.js';
import { JwksUserAuthenticator } from '../src/http/http-auth.adapters.js';
import { OperationsHttpModule } from '../src/http/operations-http.module.js';

const USER = '01990f24-2ba2-7000-8000-000000000001';
const OTHER_USER = '01990f24-2ba2-7000-8000-000000000002';
const ADMIN = '01990f24-2ba2-7000-8000-000000000003';
const TRACE = '0123456789abcdef0123456789abcdef';

describe('ticket HTTP authorization and DTOs', () => {
  it('derives the ticket owner from a verified raw bearer token and rejects body owner fields', async () => {
    const { http } = moduleFor({ userId: USER });
    const rejected = await http.handle({ method: 'POST', path: '/v1/tickets', headers: auth('user-token'), body: { subject: '问题', body: '描述', ownerId: OTHER_USER } });
    expect(rejected).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    expect((rejected.body as { traceId: string }).traceId).toMatch(/^[a-f0-9]{32}$/);
    const created = await http.handle({ method: 'POST', path: '/v1/tickets', headers: auth('user-token'), body: { subject: '问题', body: '描述' } });
    expect(created).toMatchObject({ status: 201, body: { userId: USER } });
  });

  it('returns the same TICKET_NOT_FOUND response for missing and cross-user tickets', async () => {
    const first = moduleFor({ userId: USER });
    const created = await first.http.handle({ method: 'POST', path: '/v1/tickets', headers: auth('user-token'), body: { subject: '问题', body: '描述' } });
    const ticketId = (created.body as { id: string }).id;
    const other = moduleFor({ userId: OTHER_USER, ticket: first.ticket });
    const crossUser = await other.http.handle({ method: 'GET', path: `/v1/tickets/${ticketId}`, headers: auth('other-token') });
    const missing = await other.http.handle({ method: 'GET', path: '/v1/tickets/01990f24-2ba2-7000-8000-000000000099', headers: auth('other-token') });
    expect(crossUser).toMatchObject({ status: 404, body: { code: 'TICKET_NOT_FOUND', retryable: false } });
    expect(missing).toMatchObject({ status: 404, body: { code: 'TICKET_NOT_FOUND', retryable: false } });
  });

  it('requires action-specific admin permissions and never accepts identity headers', async () => {
    const { http } = moduleFor({ userId: USER, adminPermissions: ['operations:tickets:read'] });
    const created = await http.handle({ method: 'POST', path: '/v1/tickets', headers: auth('user-token'), body: { subject: '问题', body: '描述' } });
    const ticket = created.body as { id: string; revision: number };
    const denied = await http.handle({ method: 'POST', path: `/admin/v1/tickets/${ticket.id}/claim`, headers: { authorization: 'Bearer admin-token', 'x-admin-id': ADMIN }, body: { expectedRevision: ticket.revision } });
    expect(denied).toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
    const headerOnly = moduleFor({ userId: null }).http;
    expect(await headerOnly.handle({ method: 'GET', path: '/v1/tickets', headers: { 'x-user-id': USER } })).toMatchObject({ status: 401, body: { code: 'UNAUTHENTICATED' } });
  });

  it('allows VIEWER reads but rejects support POST actions even with the action permission', async () => {
    const { http } = moduleFor({ userId: USER, adminRole: 'VIEWER', adminPermissions: ['operations:tickets:read', 'operations:tickets:claim'] });
    const created = await http.handle({ method: 'POST', path: '/v1/tickets', headers: auth('user-token'), body: { subject: 'viewer', body: 'initial' } });
    const ticket = created.body as { id: string; revision: number };
    await expect(http.handle({ method: 'GET', path: `/admin/v1/tickets/${ticket.id}`, headers: auth('admin-token') })).resolves.toMatchObject({ status: 200 });
    await expect(http.handle({ method: 'POST', path: `/admin/v1/tickets/${ticket.id}/claim`, headers: auth('admin-token'), body: { expectedRevision: ticket.revision } })).resolves.toMatchObject({ status: 403, body: { code: 'FORBIDDEN' } });
  });

  it('requires idempotency-key for messages and returns no internal notes from user GET', async () => {
    const { http } = moduleFor({ userId: USER, adminPermissions: ['operations:tickets:claim', 'operations:tickets:note'] });
    const created = await http.handle({ method: 'POST', path: '/v1/tickets', headers: auth('user-token'), body: { subject: '问题', body: '描述' } });
    const ticket = created.body as { id: string; revision: number };
    expect(await http.handle({ method: 'POST', path: `/v1/tickets/${ticket.id}/messages`, headers: auth('user-token'), body: { body: '追问', expectedRevision: ticket.revision } })).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
    const claimed = await http.handle({ method: 'POST', path: `/admin/v1/tickets/${ticket.id}/claim`, headers: auth('admin-token'), body: { expectedRevision: ticket.revision } });
    const revision = (claimed.body as { revision: number }).revision;
    await http.handle({ method: 'POST', path: `/admin/v1/tickets/${ticket.id}/internal-notes`, headers: auth('admin-token'), body: { body: 'secret-internal-note', expectedRevision: revision } });
    const userView = await http.handle({ method: 'GET', path: `/v1/tickets/${ticket.id}`, headers: auth('user-token') });
    expect(JSON.stringify(userView.body)).not.toContain('secret-internal-note');
    expect(JSON.stringify(userView.body)).not.toContain('requestHash');
    expect(JSON.stringify(userView.body)).not.toContain('idempotencyKey');
  });

  it('authenticates only verified UUIDv7 user claims', async () => {
    const authenticator = new JwksUserAuthenticator({ verify: () => Promise.resolve({ sub: USER, tokenUse: 'user', issuer: 'https://identity.internal', audience: 'operations-service' }) }, { issuer: 'https://identity.internal', audience: 'operations-service' });
    await expect(authenticator.authenticate({ headers: auth('signed-token') })).resolves.toEqual({ userId: USER });
    const wrongUse = new JwksUserAuthenticator({ verify: () => Promise.resolve({ sub: USER, tokenUse: 'admin', issuer: 'https://identity.internal', audience: 'operations-service' }) }, { issuer: 'https://identity.internal', audience: 'operations-service' });
    await expect(wrongUse.authenticate({ headers: auth('signed-token') })).resolves.toBeNull();
  });

  it('propagates valid trace IDs into stable ApiError responses', async () => {
    const { http } = moduleFor({ userId: null });
    const response = await http.handle({ method: 'GET', path: '/v1/tickets', headers: { 'x-trace-id': TRACE } });
    expect(response).toEqual({ status: 401, headers: { 'x-trace-id': TRACE }, body: { code: 'UNAUTHENTICATED', message: 'UNAUTHENTICATED', traceId: TRACE, retryable: false } });
  });

  it.each(['P1001', 'P2024', 'ECONNRESET', 'SECRET_DATABASE_FAILURE'])(
    'maps an untrusted %s error to a non-leaking retryable INTERNAL_ERROR',
    async (code) => {
      const secret = `private-${code}-diagnostic`;
      const ticket = serviceWithRepository({
        snapshot: () => Promise.reject(Object.assign(new Error(secret), { code })),
        transact: () => Promise.reject(Object.assign(new Error(secret), { code })),
      });
      const response = await moduleFor({ userId: USER, ticket }).http.handle({ method: 'GET', path: '/v1/tickets', headers: { ...auth('user-token'), 'x-trace-id': TRACE } });
      expect(response).toEqual({ status: 500, headers: { 'x-trace-id': TRACE }, body: { code: 'INTERNAL_ERROR', message: 'INTERNAL_ERROR', traceId: TRACE, retryable: true } });
      expect(JSON.stringify(response)).not.toContain(code);
      expect(JSON.stringify(response)).not.toContain(secret);
    },
  );

  it('exposes only a whitelisted cross-service domain error code', async () => {
    const ticket = new TicketService({
      repository: new InMemoryTicketRepository(),
      attachmentAuthorization: { authorize: () => Promise.resolve() },
      feedbackSubjectAuthorization: { assertTaskOwned: () => Promise.reject(Object.assign(new Error('private task lookup details'), { code: 'FEEDBACK_SUBJECT_NOT_FOUND' })) },
    });
    const response = await moduleFor({ userId: USER, ticket }).http.handle({
      method: 'POST', path: '/v1/feedback', headers: { ...auth('user-token'), 'x-trace-id': TRACE },
      body: { kind: 'FAILED_TASK', taskId: '01990f24-2ba2-7000-8000-000000000004', content: 'result issue' },
    });
    expect(response).toEqual({ status: 404, headers: { 'x-trace-id': TRACE }, body: { code: 'FEEDBACK_SUBJECT_NOT_FOUND', message: 'FEEDBACK_SUBJECT_NOT_FOUND', traceId: TRACE, retryable: false } });
    expect(JSON.stringify(response)).not.toContain('private task lookup details');
  });
});

function serviceWithRepository(repository: TicketRepository): TicketService {
  return new TicketService({ repository, attachmentAuthorization: { authorize: () => Promise.resolve() }, feedbackSubjectAuthorization: { assertTaskOwned: () => Promise.resolve() } });
}

function moduleFor(input: { userId: string | null; adminRole?: 'OWNER' | 'ADMIN' | 'VIEWER'; adminPermissions?: string[]; ticket?: TicketService }) {
  const publication = new PublicationService({ repository: new InMemoryPublicationRepository() });
  const ticket = input.ticket ?? new TicketService({ repository: new InMemoryTicketRepository(), attachmentAuthorization: { authorize: () => Promise.resolve() }, feedbackSubjectAuthorization: { assertTaskOwned: () => Promise.resolve() } });
  const http = new OperationsHttpModule({
    publication,
    ticket,
    userAuthenticator: { authenticate: () => Promise.resolve(input.userId === null ? null : { userId: input.userId }) },
    adminAuthenticator: { authenticate: () => Promise.resolve({ adminId: ADMIN, role: input.adminRole ?? 'ADMIN', permissions: input.adminPermissions ?? [] }) },
  });
  return { http, ticket };
}

function auth(token: string): Record<string, string> { return { authorization: `Bearer ${token}` }; }
