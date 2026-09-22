/* eslint-disable @typescript-eslint/require-await -- Prisma promise mocks model asynchronous client delegates. */
import { describe, expect, it, vi } from 'vitest';

import { PrismaIamAdministrationRepository } from '../src/adapters/prisma-iam-administration.repository.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';

const ACTOR_ID = generateUuidV7();
const ADMIN_ID = generateUuidV7();
const ROLE_ID = generateUuidV7();
const PERMISSION_ID = generateUuidV7();
const AUDIT_ID = generateUuidV7();
const NOW = new Date('2026-09-02T01:00:00.000Z');

describe('PrismaIamAdministrationRepository without an external database', () => {
  it('loads inactive, protected, and scoped authorization subjects', async () => {
    const fixture = createFixture();
    fixture.prisma.adminUser.findFirst.mockResolvedValueOnce(null);
    await expect(fixture.repository.loadAuthorizationSubject(ACTOR_ID)).resolves.toBeNull();

    await expect(fixture.repository.loadAuthorizationSubject(ACTOR_ID)).resolves.toEqual({
      adminId: ACTOR_ID,
      grants: [{ permission: 'wallet:adjust', dataScope: 'ALL' }],
    });

    fixture.prisma.adminUser.findFirst.mockResolvedValueOnce(actor(false, 'OWN'));
    await expect(fixture.repository.loadAuthorizationSubject(ACTOR_ID)).resolves.toEqual({
      adminId: ACTOR_ID,
      grants: [{ permission: 'wallet:adjust', dataScope: 'OWN' }],
    });
  });

  it('lists permissions and roles with bounded cursor pagination', async () => {
    const fixture = createFixture();
    await expect(fixture.repository.listPermissions()).resolves.toEqual([
      { id: PERMISSION_ID, key: 'wallet:adjust', description: 'Adjust a wallet' },
    ]);

    fixture.prisma.role.findMany.mockResolvedValueOnce([
      roleRow({ name: 'alpha-role' }),
      roleRow({ id: generateUuidV7(), name: 'beta-role' }),
    ]);
    const first = await fixture.repository.listRoles({ limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));

    fixture.prisma.role.findMany.mockResolvedValueOnce([roleRow({ name: 'beta-role' })]);
    const second = await fixture.repository.listRoles({ cursor: first.nextCursor ?? '', limit: 1 });
    expect(second.nextCursor).toBeNull();
    const roleQuery = record(fixture.prisma.role.findMany.mock.calls.at(-1)?.[0]);
    expect(Array.isArray(record(roleQuery['where'])['OR'])).toBe(true);
    expect(roleQuery['take']).toBe(2);
    await expect(
      fixture.repository.listRoles({ cursor: 'not-a-cursor', limit: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ROLE_QUERY' });
  });

  it('appends redacted audit data through the configured transaction', async () => {
    const fixture = createFixture();
    await fixture.repository.appendAudit(
      audit({
        before: { password: 'never-log', nested: { token: 'also-secret' } },
        after: { allowed: true },
      }),
    );
    expect(fixture.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: 'ReadCommitted',
      maxWait: 5_000,
      timeout: 10_000,
    });
    const persisted = record(record(fixture.prisma.auditEvent.create.mock.calls[0]?.[0])['data']);
    expect(persisted['before']).toEqual({
      password: '[REDACTED]',
      nested: { token: '[REDACTED]' },
    });
    expect(persisted['after']).toEqual({ allowed: true });
  });

  it('bootstraps a protected super administrator and records denied alternatives', async () => {
    const fixture = createFixture();
    await expect(
      fixture.repository.bootstrapSuperAdmin({
        adminId: ADMIN_ID,
        roleId: ROLE_ID,
        audit: audit(),
      }),
    ).resolves.toMatchObject({ kind: 'created', role: { protected: true, name: 'SUPER_ADMIN' } });
    expect(fixture.prisma.adminRole.create).toHaveBeenCalledWith({
      data: {
        adminId: ADMIN_ID,
        roleId: ROLE_ID,
        assignedBy: ADMIN_ID,
      },
    });
    expect(advisorySql(fixture)).toContain('SELECT 1::integer AS "acquired"');

    fixture.prisma.role.findFirst.mockResolvedValueOnce(roleRow({ protected: true }));
    await expect(
      fixture.repository.bootstrapSuperAdmin({
        adminId: ADMIN_ID,
        roleId: ROLE_ID,
        audit: audit(),
      }),
    ).resolves.toEqual({ kind: 'already_bootstrapped' });

    fixture.prisma.adminUser.findUnique.mockResolvedValueOnce({ ...admin(), status: 'DISABLED' });
    await expect(
      fixture.repository.bootstrapSuperAdmin({
        adminId: ADMIN_ID,
        roleId: ROLE_ID,
        audit: audit(),
      }),
    ).resolves.toEqual({ kind: 'admin_inactive' });
  });

  it('creates, updates, and deletes roles atomically', async () => {
    const fixture = createFixture();
    const created = await fixture.repository.createRole({
      role: roleInput(),
      audit: audit(),
    });
    expect(created).toMatchObject({ kind: 'created', role: { permissionKeys: ['wallet:adjust'] } });
    expect(fixture.prisma.rolePermission.createMany).toHaveBeenCalled();

    const updated = await fixture.repository.updateRole({
      roleId: ROLE_ID,
      expectedVersion: 1,
      name: 'wallet-operators-v2',
      description: 'Updated operators',
      dataScope: 'OWN',
      permissionKeys: ['wallet:adjust'],
      audit: audit(),
    });
    expect(updated.kind).toBe('updated');
    expect(fixture.prisma.role.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ROLE_ID, version: 1, protected: false },
      }),
    );

    await expect(
      fixture.repository.deleteRole({
        roleId: ROLE_ID,
        expectedVersion: 1,
        audit: audit(),
      }),
    ).resolves.toBe('deleted');
    expect(fixture.prisma.role.deleteMany).toHaveBeenCalled();
  });

  it('returns stable role mutation outcomes for lock-time conflicts', async () => {
    const fixture = createFixture();
    fixture.prisma.adminUser.findFirst.mockResolvedValueOnce(null);
    await expect(
      fixture.repository.createRole({ role: roleInput(), audit: audit() }),
    ).resolves.toEqual({ kind: 'actor_denied' });

    fixture.prisma.role.findUnique.mockResolvedValueOnce(null);
    await expect(
      fixture.repository.updateRole({
        roleId: ROLE_ID,
        expectedVersion: 1,
        name: 'missing-role',
        description: 'Missing',
        dataScope: 'OWN',
        permissionKeys: [],
        audit: audit(),
      }),
    ).resolves.toEqual({ kind: 'not_found' });

    fixture.prisma.role.findUnique.mockResolvedValueOnce(roleRow({ protected: true }));
    await expect(
      fixture.repository.deleteRole({ roleId: ROLE_ID, expectedVersion: 1, audit: audit() }),
    ).resolves.toBe('protected');
  });

  it('assigns and revokes roles with lock-time authorization checks', async () => {
    const fixture = createFixture();
    await expect(
      fixture.repository.assignRole({
        adminId: ADMIN_ID,
        roleId: ROLE_ID,
        assignedBy: ACTOR_ID,
        audit: audit(),
      }),
    ).resolves.toBe('assigned');

    fixture.prisma.adminRole.findUnique.mockResolvedValueOnce({
      adminId: ADMIN_ID,
      roleId: ROLE_ID,
      assignedBy: ACTOR_ID,
      assignedAt: NOW,
    });
    await expect(
      fixture.repository.revokeRole({
        adminId: ADMIN_ID,
        roleId: ROLE_ID,
        expectedAssignment: true,
        audit: audit(),
      }),
    ).resolves.toBe('revoked');

    await expect(
      fixture.repository.assignRole({
        adminId: ADMIN_ID,
        roleId: ROLE_ID,
        assignedBy: ADMIN_ID,
        audit: audit(),
      }),
    ).resolves.toBe('actor_denied');
  });

  it('disables an administrator and atomically clears pending and active sessions', async () => {
    const fixture = createFixture();
    await expect(
      fixture.repository.disableAdmin({ adminId: ADMIN_ID, audit: audit() }),
    ).resolves.toBe('disabled');
    expect(fixture.prisma.adminUser.updateMany).toHaveBeenCalledWith({
      where: { id: ADMIN_ID, status: 'ACTIVE' },
      data: { status: 'DISABLED' },
    });
    expect(fixture.prisma.mfaChallenge.updateMany).toHaveBeenCalled();
    expect(fixture.prisma.mfaRecoveryCode.updateMany).toHaveBeenCalled();
    expect(fixture.prisma.adminSession.updateMany).toHaveBeenCalledTimes(2);

    fixture.prisma.adminUser.findUnique.mockResolvedValueOnce(null);
    await expect(
      fixture.repository.disableAdmin({ adminId: ADMIN_ID, audit: audit() }),
    ).resolves.toBe('not_found');
  });

  it('queries a bounded audit page with filters and rejects malformed cursors', async () => {
    const fixture = createFixture();
    fixture.prisma.auditEvent.findMany.mockResolvedValueOnce([
      auditRow(),
      auditRow({ id: generateUuidV7(), occurredAt: new Date(NOW.getTime() - 1_000) }),
    ]);
    const first = await fixture.repository.queryAudit({
      actorId: ACTOR_ID,
      action: 'role.create',
      resourceType: 'role',
      resourceId: ROLE_ID,
      outcome: 'SUCCESS',
      from: new Date(NOW.getTime() - 5_000),
      to: NOW,
      limit: 1,
    });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await fixture.repository.queryAudit({
      cursor: first.nextCursor ?? '',
      limit: 1,
    });
    expect(Array.isArray(second.items)).toBe(true);
    await expect(fixture.repository.queryAudit({ cursor: 'bad', limit: 1 })).rejects.toMatchObject({
      code: 'INVALID_AUDIT_QUERY',
    });
  });

  it('supports an already-open transaction client without nesting a transaction', async () => {
    const fixture = createFixture();
    const transactionClient = { ...fixture.prisma };
    Reflect.deleteProperty(transactionClient, '$transaction');
    const repository = new PrismaIamAdministrationRepository(
      transactionClient as unknown as ConstructorParameters<
        typeof PrismaIamAdministrationRepository
      >[0],
    );
    await repository.appendAudit(audit());
    expect(fixture.prisma.auditEvent.create).toHaveBeenCalled();
  });
});

function createFixture() {
  const permission = { id: PERMISSION_ID, key: 'wallet:adjust', description: 'Adjust a wallet' };
  const transaction = vi.fn();
  const prisma = {
    $transaction: transaction,
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = sqlText(query);
      if (sql.includes('count(DISTINCT')) return [{ count: 2 }];
      if (sql.includes('clock_timestamp')) return [{ now: NOW }];
      if (sql.includes('FROM "admin_users"')) return [{ id: ADMIN_ID }];
      if (sql.includes('FROM "roles"')) return [{ id: ROLE_ID }];
      return [{ acquired: 1 }];
    }),
    adminUser: {
      findFirst: promiseMock(actor(true, 'ALL')),
      findUnique: promiseMock(admin()),
      updateMany: promiseMock({ count: 1 }),
    },
    permission: { findMany: promiseMock([permission]) },
    role: {
      findMany: promiseMock([roleRow()]),
      findFirst: promiseMock(null),
      findUnique: vi.fn<(input?: unknown) => Promise<unknown>>(async (input: unknown) => {
        const where = record(record(input)['where']);
        return typeof where['name'] === 'string' ? null : roleRow();
      }),
      create: vi.fn<(input?: unknown) => Promise<unknown>>(async (input: unknown) =>
        roleRow(record(record(input)['data'])),
      ),
      updateMany: promiseMock({ count: 1 }),
      deleteMany: promiseMock({ count: 1 }),
    },
    rolePermission: {
      createMany: promiseMock({ count: 1 }),
      deleteMany: promiseMock({ count: 1 }),
    },
    adminRole: {
      create: promiseMock({}),
      findUnique: promiseMock(null),
      findFirst: promiseMock(null),
      deleteMany: promiseMock({ count: 1 }),
      count: promiseMock(0),
    },
    adminSession: {
      findMany: promiseMock([{ id: generateUuidV7() }]),
      updateMany: promiseMock({ count: 1 }),
    },
    mfaChallenge: { updateMany: promiseMock({ count: 1 }) },
    mfaRecoveryCode: { updateMany: promiseMock({ count: 1 }) },
    auditEvent: {
      create: promiseMock(auditRow()),
      findMany: promiseMock([auditRow()]),
    },
  };
  transaction.mockImplementation(async (work: unknown) =>
    (work as (client: typeof prisma) => Promise<unknown>)(prisma),
  );
  return {
    prisma,
    repository: new PrismaIamAdministrationRepository(
      prisma as unknown as ConstructorParameters<typeof PrismaIamAdministrationRepository>[0],
    ),
  };
}

function actor(protectedRole: boolean, dataScope: 'ALL' | 'OWN' | 'ASSIGNED') {
  return {
    ...admin(ACTOR_ID),
    roles: [
      {
        role: {
          ...roleRow({ id: generateUuidV7(), protected: protectedRole, dataScope }),
          permissions: [{ permission: { id: PERMISSION_ID, key: 'wallet:adjust' } }],
        },
      },
    ],
  };
}

function admin(id = ADMIN_ID) {
  return { id, email: 'admin@example.test', passwordHash: 'digest', status: 'ACTIVE' };
}

function roleInput() {
  return {
    id: ROLE_ID,
    name: 'wallet-operators',
    description: 'Wallet operators',
    dataScope: 'OWN' as const,
    permissionKeys: ['wallet:adjust'],
  };
}

function roleRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: ROLE_ID,
    name: 'wallet-operators',
    description: 'Wallet operators',
    dataScope: 'OWN',
    version: 1,
    protected: false,
    createdAt: NOW,
    updatedAt: NOW,
    permissions: [{ permission: { id: PERMISSION_ID, key: 'wallet:adjust' } }],
    ...overrides,
  };
}

function audit(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: AUDIT_ID,
    action: 'role.create',
    resourceType: 'role',
    resourceId: ROLE_ID,
    outcome: 'SUCCESS' as const,
    context: {
      actorId: ACTOR_ID,
      ipAddress: '127.0.0.1',
      userAgent: 'prisma-unit-test',
      traceId: 'a'.repeat(32),
      correlationId: generateUuidV7(),
      occurredAt: NOW,
    },
    ...overrides,
  };
}

function auditRow(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: AUDIT_ID,
    actorId: ACTOR_ID,
    action: 'role.create',
    resourceType: 'role',
    resourceId: ROLE_ID,
    before: null,
    after: null,
    outcome: 'SUCCESS',
    reasonCode: null,
    ipAddress: '127.0.0.1',
    userAgent: 'prisma-unit-test',
    traceId: 'a'.repeat(32),
    correlationId: generateUuidV7(),
    causationId: null,
    occurredAt: NOW,
    createdAt: NOW,
    ...overrides,
  };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function promiseMock(value: unknown) {
  return vi.fn<(input?: unknown) => Promise<unknown>>(async () => value);
}

function sqlText(value: unknown): string {
  const strings = record(value)['strings'];
  return Array.isArray(strings) ? strings.join(' ') : '';
}

function advisorySql(fixture: ReturnType<typeof createFixture>): string {
  return fixture.prisma.$queryRaw.mock.calls
    .map(([query]) => sqlText(query))
    .filter((sql) => sql.includes('pg_advisory_xact_lock'))
    .join('\n');
}
