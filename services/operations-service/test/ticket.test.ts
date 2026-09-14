import { describe, expect, it } from 'vitest';
import {
  InMemoryTicketRepository,
  TicketService,
  validateTicketEventEnvelope,
  type AttachmentAuthorizationPort,
  type FeedbackSubjectAuthorizationPort,
} from '../src/application/ticket.service.js';

const USER = '01990f24-2ba2-7000-8000-000000000001';
const OTHER_USER = '01990f24-2ba2-7000-8000-000000000002';
const ADMIN = '01990f24-2ba2-7000-8000-000000000003';
const OTHER_ADMIN = '01990f24-2ba2-7000-8000-000000000004';
const ASSET = '01990f24-2ba2-7000-8000-000000000005';
const OTHER_ASSET = '01990f24-2ba2-7000-8000-000000000006';
const SESSION = '01990f24-2ba2-7000-8000-000000000007';
const TASK = '01990f24-2ba2-7000-8000-000000000008';
const TRACE = '0123456789abcdef0123456789abcdef';
const CORRELATION = '01990f24-2ba2-7000-8000-000000000009';
const context = { traceId: TRACE, correlationId: CORRELATION };

describe('secure support ticket workflow', () => {
  it('returns TICKET_NOT_FOUND when one user reads another user ticket', async () => {
    const { service } = fixture();
    const ticket = await service.create({ subject: '生成失败', body: '请帮忙查看' }, USER, context);
    await expect(service.get(ticket.id, OTHER_USER)).rejects.toMatchObject({ code: 'TICKET_NOT_FOUND' });
  });

  it('requires an agent public reply before resolving', async () => {
    const { service } = fixture();
    const ticket = await service.create({ subject: '生成失败', body: '请帮忙查看' }, USER, context);
    const claimed = await service.claim(ticket.id, ticket.revision, ADMIN, context);
    await expect(service.resolve(ticket.id, claimed.revision, ADMIN, context)).rejects.toMatchObject({ code: 'TICKET_REPLY_REQUIRED' });
  });

  it('allows reopen exactly seven days after resolution but rejects one millisecond later and never reopens CLOSED', async () => {
    const clock = new MutableClock('2026-09-01T00:00:00.000Z');
    const { service } = fixture(clock);
    const ticket = await service.create({ subject: '问题', body: '描述' }, USER, context);
    const claimed = await service.claim(ticket.id, ticket.revision, ADMIN, context);
    const replied = await service.reply(ticket.id, { body: '已处理', expectedRevision: claimed.revision }, ADMIN, 'reply-1', context);
    const resolved = await service.resolve(ticket.id, replied.ticket.revision, ADMIN, context);

    clock.set('2026-09-08T00:00:00.000Z');
    const reopened = await service.reopen(ticket.id, resolved.revision, USER, context);
    expect(reopened.status).toBe('IN_PROGRESS');

    const repliedAgain = await service.reply(ticket.id, { body: '再次处理', expectedRevision: reopened.revision }, ADMIN, 'reply-2', context);
    const resolvedAgain = await service.resolve(ticket.id, repliedAgain.ticket.revision, ADMIN, context);
    clock.set('2026-09-15T00:00:00.001Z');
    await expect(service.reopen(ticket.id, resolvedAgain.revision, USER, context)).rejects.toMatchObject({ code: 'TICKET_REOPEN_WINDOW_EXPIRED' });
    const closed = await service.close(ticket.id, resolvedAgain.revision, ADMIN, context);
    await expect(service.reopen(ticket.id, closed.revision, USER, context)).rejects.toMatchObject({ code: 'TICKET_INVALID_TRANSITION' });
  });

  it('requires a new public agent reply in every reopened resolution cycle', async () => {
    const clock = new MutableClock('2026-09-01T00:00:00.000Z');
    const { service } = fixture(clock);
    const created = await service.create({ subject: 'cycle', body: 'initial' }, USER, context);
    const claimed = await service.claim(created.id, created.revision, ADMIN, context);
    const firstReply = await service.reply(created.id, { body: 'cycle zero reply', expectedRevision: claimed.revision }, ADMIN, 'cycle-zero', context);
    const resolved = await service.resolve(created.id, firstReply.ticket.revision, ADMIN, context);
    clock.set('2026-09-02T00:00:00.000Z');
    const reopened = await service.reopen(created.id, resolved.revision, USER, context);
    expect(reopened.resolutionCycle).toBe(1);
    await expect(service.resolve(created.id, reopened.revision, ADMIN, context)).rejects.toMatchObject({ code: 'TICKET_REPLY_REQUIRED' });
    const secondReply = await service.reply(created.id, { body: 'cycle one reply', expectedRevision: reopened.revision }, ADMIN, 'cycle-one', context);
    await expect(service.resolve(created.id, secondReply.ticket.revision, ADMIN, context)).resolves.toMatchObject({ status: 'RESOLVED', resolutionCycle: 1 });
  });

  it('keeps internal notes out of user DTOs and every outbox event', async () => {
    const { service, repository } = fixture();
    const ticket = await service.create({ subject: '问题', body: '描述' }, USER, context);
    const claimed = await service.claim(ticket.id, ticket.revision, ADMIN, context);
    const secret = '仅内部：给用户退款前先核对';
    await service.addInternalNote(ticket.id, { body: secret, expectedRevision: claimed.revision }, ADMIN);

    expect(JSON.stringify(await service.get(ticket.id, USER))).not.toContain(secret);
    expect(JSON.stringify(repository.outboxEvents())).not.toContain(secret);
    expect((await service.getForAdmin(ticket.id)).internalNotes).toEqual([expect.objectContaining({ body: secret })]);
  });

  it('authorizes attachments from trusted asset ownership or a live one-use support session', async () => {
    const clock = new MutableClock('2026-09-01T00:00:00.000Z');
    const attachments = new FakeAttachmentAuthorization(clock);
    attachments.own(ASSET, USER);
    attachments.own(OTHER_ASSET, OTHER_USER);
    attachments.session(SESSION, OTHER_ASSET, USER, '2026-09-01T00:15:00.000Z');
    const { service } = fixture(clock, attachments);

    await expect(service.create({ subject: '附件', body: '我的', attachments: [{ assetId: ASSET }] }, USER, context)).resolves.toBeDefined();
    await expect(service.create({ subject: '附件', body: '授权', attachments: [{ assetId: OTHER_ASSET, supportUploadSessionId: SESSION }] }, USER, context)).resolves.toBeDefined();
    await expect(service.create({ subject: '附件', body: '重放', attachments: [{ assetId: OTHER_ASSET, supportUploadSessionId: SESSION }] }, USER, context)).rejects.toMatchObject({ code: 'SUPPORT_UPLOAD_SESSION_USED' });

    const expiredSession = '01990f24-2ba2-7000-8000-000000000010';
    attachments.session(expiredSession, OTHER_ASSET, USER, '2026-08-31T23:59:59.999Z');
    await expect(service.create({ subject: '附件', body: '过期', attachments: [{ assetId: OTHER_ASSET, supportUploadSessionId: expiredSession }] }, USER, context)).rejects.toMatchObject({ code: 'SUPPORT_UPLOAD_SESSION_EXPIRED' });
  });

  it('uses CAS for concurrent claims and deduplicates concurrent replies by idempotency key', async () => {
    const { service } = fixture();
    const ticket = await service.create({ subject: '并发', body: '描述' }, USER, context);
    const claims = await Promise.allSettled([
      service.claim(ticket.id, ticket.revision, ADMIN, context),
      service.claim(ticket.id, ticket.revision, OTHER_ADMIN, context),
    ]);
    expect(claims.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    const rejected = claims.filter((item): item is PromiseRejectedResult => item.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect((rejected[0]?.reason as { code: string }).code).toBe('TICKET_REVISION_CONFLICT');
    const claimed = (await service.getForAdmin(ticket.id)).ticket;
    if (claimed.assigneeId === null) throw new Error('claim did not assign');
    const replies = await Promise.all([
      service.reply(ticket.id, { body: '公开回复', expectedRevision: claimed.revision }, claimed.assigneeId, 'same-key', context),
      service.reply(ticket.id, { body: '公开回复', expectedRevision: claimed.revision }, claimed.assigneeId, 'same-key', context),
    ]);
    expect(replies[0].message.id).toBe(replies[1].message.id);
    expect((await service.get(ticket.id, USER)).messages.filter((message) => message.authorType === 'AGENT')).toHaveLength(1);
    await expect(service.reply(ticket.id, { body: '不同内容', expectedRevision: replies[0].ticket.revision }, claimed.assigneeId, 'same-key', context)).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('rejects illegal state transitions and stale revisions', async () => {
    const { service } = fixture();
    const ticket = await service.create({ subject: '状态', body: '描述' }, USER, context);
    await expect(service.resolve(ticket.id, ticket.revision, ADMIN, context)).rejects.toMatchObject({ code: 'TICKET_INVALID_TRANSITION' });
    const claimed = await service.claim(ticket.id, ticket.revision, ADMIN, context);
    await expect(service.claim(ticket.id, ticket.revision, ADMIN, context)).rejects.toMatchObject({ code: 'TICKET_REVISION_CONFLICT' });
    await expect(service.close(ticket.id, claimed.revision, ADMIN, context)).rejects.toMatchObject({ code: 'TICKET_INVALID_TRANSITION' });
  });

  it('uses a stable descending keyset cursor without skipping older tickets', async () => {
    const clock = new MutableClock('2026-09-01T00:00:00.000Z');
    const { service } = fixture(clock);
    await service.create({ subject: 'oldest', body: 'x' }, USER, context);
    clock.set('2026-09-01T00:00:01.000Z');
    await service.create({ subject: 'middle', body: 'x' }, USER, context);
    clock.set('2026-09-01T00:00:02.000Z');
    await service.create({ subject: 'newest', body: 'x' }, USER, context);
    const first = await service.list(USER, { limit: 2 });
    expect(first.items.map((ticket) => ticket.subject)).toEqual(['newest', 'middle']);
    expect(first.nextCursor).toBeTypeOf('string');
    if (first.nextCursor === undefined) throw new Error('expected next cursor');
    const second = await service.list(USER, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((ticket) => ticket.subject)).toEqual(['oldest']);
    expect(second.nextCursor).toBeUndefined();
  });

  it('creates feedback only for the authenticated user and owned task, without putting content in events', async () => {
    const feedbackSubjects: FeedbackSubjectAuthorizationPort = {
      assertTaskOwned: (taskId, userId) => taskId === TASK && userId === USER ? Promise.resolve() : Promise.reject(Object.assign(new Error('FEEDBACK_SUBJECT_NOT_FOUND'), { code: 'FEEDBACK_SUBJECT_NOT_FOUND' })),
    };
    const { service, repository } = fixture(undefined, undefined, feedbackSubjects);
    const created = await service.createFeedback({ kind: 'FAILED_TASK', taskId: TASK, content: '失败详情是隐私', rating: 2 }, USER, context);
    expect(created.userId).toBe(USER);
    await expect(service.getFeedback(created.id, OTHER_USER)).rejects.toMatchObject({ code: 'FEEDBACK_NOT_FOUND' });
    await expect(service.createFeedback({ kind: 'FAILED_TASK', taskId: TASK, content: '冒用', rating: 6 }, OTHER_USER, context)).rejects.toMatchObject({ code: 'INVALID_FEEDBACK' });
    expect(JSON.stringify(repository.outboxEvents())).not.toContain('失败详情是隐私');
  });

  it('rejects malformed ticket EventEnvelope ids, types and request context before persistence', () => {
    const base = { id: '01990f24-2ba2-7000-8000-000000000001', type: 'operations.ticket.created.v1', version: 1, occurredAt: '2026-09-01T00:00:00.000Z', traceId: '0123456789abcdef0123456789abcdef', correlationId: '01990f24-2ba2-7000-8000-000000000002', producer: 'operations-service', data: {} };
    expect(() => { validateTicketEventEnvelope({ ...base, id: 'bad-id' }); }).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST_CONTEXT' }));
    expect(() => { validateTicketEventEnvelope({ ...base, type: 'BAD_TYPE' }); }).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST_CONTEXT' }));
    expect(() => { validateTicketEventEnvelope({ ...base, traceId: 'bad-trace' }); }).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST_CONTEXT' }));
    expect(() => { validateTicketEventEnvelope({ ...base, correlationId: 'bad-correlation' }); }).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST_CONTEXT' }));
  });
});

function fixture(
  clock = new MutableClock('2026-09-01T00:00:00.000Z'),
  attachments: AttachmentAuthorizationPort = { authorize: () => Promise.resolve() },
  feedbackSubjects: FeedbackSubjectAuthorizationPort = { assertTaskOwned: () => Promise.resolve() },
) {
  const repository = new InMemoryTicketRepository();
  const service = new TicketService({ repository, attachmentAuthorization: attachments, feedbackSubjectAuthorization: feedbackSubjects, now: () => clock.now(), id: idGenerator() });
  return { repository, service };
}

class MutableClock {
  #value: Date;
  constructor(value: string) { this.#value = new Date(value); }
  now(): Date { return new Date(this.#value); }
  set(value: string): void { this.#value = new Date(value); }
}

class FakeAttachmentAuthorization implements AttachmentAuthorizationPort {
  readonly #owners = new Map<string, string>();
  readonly #sessions = new Map<string, { assetId: string; ownerId: string; expiresAt: Date; used: boolean }>();
  constructor(private readonly clock: MutableClock) {}
  own(assetId: string, ownerId: string): void { this.#owners.set(assetId, ownerId); }
  session(id: string, assetId: string, ownerId: string, expiresAt: string): void { this.#sessions.set(id, { assetId, ownerId, expiresAt: new Date(expiresAt), used: false }); }
  authorize(input: { assetId: string; ownerId: string; supportUploadSessionId?: string }): Promise<void> {
    if (this.#owners.get(input.assetId) === input.ownerId) return Promise.resolve();
    const session = input.supportUploadSessionId === undefined ? undefined : this.#sessions.get(input.supportUploadSessionId);
    if (session === undefined || session.assetId !== input.assetId || session.ownerId !== input.ownerId) return Promise.reject(Object.assign(new Error('ATTACHMENT_NOT_AUTHORIZED'), { code: 'ATTACHMENT_NOT_AUTHORIZED' }));
    if (session.used) return Promise.reject(Object.assign(new Error('SUPPORT_UPLOAD_SESSION_USED'), { code: 'SUPPORT_UPLOAD_SESSION_USED' }));
    if (session.expiresAt < this.clock.now()) return Promise.reject(Object.assign(new Error('SUPPORT_UPLOAD_SESSION_EXPIRED'), { code: 'SUPPORT_UPLOAD_SESSION_EXPIRED' }));
    session.used = true;
    return Promise.resolve();
  }
}

function idGenerator(): () => string {
  let value = 0x100;
  return () => `01990f24-2ba2-7000-8000-${(value++).toString(16).padStart(12, '0')}`;
}
