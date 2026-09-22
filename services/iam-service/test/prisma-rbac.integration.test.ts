import { randomBytes } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PrismaPg } from '@prisma/adapter-pg';
import { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PrismaAdminAuthRepository } from '../src/adapters/prisma-admin-auth.repository.js';
import type { PrismaIamAdministrationRepository } from '../src/adapters/prisma-iam-administration.repository.js';
import type { AuditDecisionInput } from '../src/application/iam-administration.repository.js';
import { can } from '../src/domain/authorization.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';
import { Prisma, PrismaClient } from '../src/generated/prisma/client.js';
import { resolveIamTestDatabaseUrl } from './test-targets.js';

const baseDatabaseUrl = resolveIamTestDatabaseUrl({
  IAM_TEST_DATABASE_URL: process.env['IAM_TEST_DATABASE_URL'],
});
const integration = baseDatabaseUrl ? it : it.skip;
const isolatedDatabaseName = `iam_test_rbac_${randomBytes(8).toString('hex')}`;
const sentinelId = generateUuidV7();
let administrativeClient: PgClient | null = null;
let prisma: PrismaClient | null = null;
let isolatedDatabaseCreated = false;
let rootId = '';
let secondId = '';
let operatorId = '';
let protectedRoleId = '';
let auditSequence = 0;
let AdministrationRepository: typeof PrismaIamAdministrationRepository | null = null;

describe('Prisma IAM RBAC integration in an isolated test database', () => {
  beforeAll(async () => {
    if (!baseDatabaseUrl) return;
    try {
      ({ PrismaIamAdministrationRepository: AdministrationRepository } =
        await import('../src/adapters/prisma-iam-administration.repository.js'));
      administrativeClient = new PgClient({ connectionString: baseDatabaseUrl });
      await administrativeClient.connect();
      await administrativeClient.query(
        `CREATE DATABASE "${isolatedDatabaseName}" TEMPLATE template0`,
      );
      isolatedDatabaseCreated = true;
      const isolatedUrl = databaseUrl(baseDatabaseUrl, isolatedDatabaseName);
      const migrationClient = new PgClient({ connectionString: isolatedUrl });
      try {
        await migrationClient.connect();
        const migrationsRoot = join(import.meta.dirname, '../prisma/migrations');
        const directories = (await readdir(migrationsRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();
        for (const directory of directories) {
          await migrationClient.query(
            await readFile(join(migrationsRoot, directory, 'migration.sql'), 'utf8'),
          );
        }
      } finally {
        await migrationClient.end();
      }
      prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: isolatedUrl }) });
      await prisma.adminUser.create({
        data: {
          id: sentinelId,
          email: `iam-rbac-sentinel-${sentinelId}@example.test`,
          passwordHash: '$argon2id$v=19$m=65536,p=1,t=3$sentinel$sentinel',
        },
      });
      rootId = await createAdmin('root');
      secondId = await createAdmin('second');
      operatorId = await createAdmin('operator');
      await seedPermission('iam:roles:read');
      await seedPermission('iam:roles:write');
      await seedPermission('iam:admins:write');
      await seedPermission('iam:permissions:read');
      await seedPermission('audit:read');
      await seedPermission('users:read');
      await seedPermission('wallet:adjust');

      const repository = new (requireAdministrationRepository())(requirePrisma());
      const bootstrap = await repository.bootstrapSuperAdmin({
        adminId: rootId,
        roleId: generateUuidV7(),
        audit: decision('super-admin.bootstrap', 'admin', rootId),
      });
      if (bootstrap.kind !== 'created') throw new Error('EXPECTED_BOOTSTRAP');
      protectedRoleId = bootstrap.role.id;
      await repository.assignRole({
        adminId: secondId,
        roleId: protectedRoleId,
        assignedBy: rootId,
        audit: decision('admin-role.assign', 'admin', secondId),
      });
    } catch (setupError: unknown) {
      try {
        await cleanupIsolatedDatabase(false);
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [setupError, cleanupError],
          'IAM_RBAC_TEST_SETUP_AND_CLEANUP_FAILED',
          { cause: cleanupError },
        );
      }
      throw setupError;
    }
  }, 30_000);

  afterAll(async () => {
    await cleanupIsolatedDatabase(true);
  }, 30_000);

  integration('enforces role CAS and persisted data-scope authorization', async () => {
    const repository = new (requireAdministrationRepository())(requirePrisma());
    const roleId = generateUuidV7();
    const created = await repository.createRole({
      role: {
        id: roleId,
        name: `assigned-reader-${randomBytes(4).toString('hex')}`,
        description: 'Assigned user reader',
        dataScope: 'ASSIGNED',
        permissionKeys: ['users:read'],
      },
      audit: decision('role.create', 'role', roleId),
    });
    expect(created.kind).toBe('created');
    await repository.assignRole({
      adminId: operatorId,
      roleId,
      assignedBy: rootId,
      audit: decision('admin-role.assign', 'admin', operatorId),
    });
    const subject = await repository.loadAuthorizationSubject(operatorId);
    if (!subject) throw new Error('EXPECTED_SUBJECT');
    expect(can(subject, 'users:read', { assignedAdminIds: [operatorId] })).toBe(true);
    expect(can(subject, 'users:read', { assignedAdminIds: [rootId] })).toBe(false);

    const updates = await Promise.all([
      repository.updateRole({
        roleId,
        expectedVersion: 1,
        name: `assigned-reader-a-${randomBytes(4).toString('hex')}`,
        description: 'First concurrent update',
        dataScope: 'OWN',
        permissionKeys: ['users:read'],
        audit: decision('role.update', 'role', roleId),
      }),
      repository.updateRole({
        roleId,
        expectedVersion: 1,
        name: `assigned-reader-b-${randomBytes(4).toString('hex')}`,
        description: 'Second concurrent update',
        dataScope: 'ALL',
        permissionKeys: ['users:read'],
        audit: decision('role.update', 'role', roleId),
      }),
    ]);
    expect(updates.map(({ kind }) => kind).sort()).toEqual(['updated', 'version_conflict']);
    await expect(repository.listPermissions()).resolves.toHaveLength(7);
    const rolePage = await repository.listRoles({ limit: 1 });
    expect(rolePage.items).toHaveLength(1);
    expect(typeof rolePage.nextCursor).toBe('string');
    const audits = await repository.queryAudit({
      resourceType: 'role',
      resourceId: roleId,
      limit: 20,
    });
    expect(audits.items.some((event) => event.outcome === 'DENIED')).toBe(true);
    await expect(
      repository.deleteRole({
        roleId,
        expectedVersion: 2,
        audit: decision('role.delete', 'role', roleId),
      }),
    ).resolves.toBe('assigned');
    await repository.revokeRole({
      adminId: operatorId,
      roleId,
      expectedAssignment: true,
      audit: decision('admin-role.revoke', 'admin', operatorId),
    });
    await expect(
      repository.deleteRole({
        roleId,
        expectedVersion: 2,
        audit: decision('role.delete', 'role', roleId),
      }),
    ).resolves.toBe('deleted');
    await expect(
      repository.listRoles({
        cursor: Buffer.from('role|not-a-uuid').toString('base64url'),
        limit: 10,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_ROLE_QUERY',
    });
    await expect(
      repository.queryAudit({
        cursor: Buffer.from('2026-09-01T00:00:00.000Z|not-a-uuid').toString('base64url'),
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIT_QUERY' });
  });

  integration('database triggers reject audit mutation and protected-role mutation', async () => {
    const client = requirePrisma();
    const repository = new (requireAdministrationRepository())(client);
    const audit = decision('security.settings.update', 'admin', rootId, {
      passwordHash: 'must-not-persist',
      nested: { recoveryCode: 'must-not-persist' },
    });
    await repository.appendAudit(audit);
    const stored = await client.auditEvent.findUniqueOrThrow({ where: { id: audit.id } });
    expect(stored.after).toEqual({
      passwordHash: '[REDACTED]',
      nested: { recoveryCode: '[REDACTED]' },
    });
    await expect(
      client.$executeRaw(
        Prisma.sql`UPDATE "audit_events" SET "action" = 'tampered' WHERE "id" = CAST(${audit.id} AS uuid)`,
      ),
    ).rejects.toThrow();
    await expect(
      client.$executeRaw(
        Prisma.sql`DELETE FROM "audit_events" WHERE "id" = CAST(${audit.id} AS uuid)`,
      ),
    ).rejects.toThrow();
    await expect(client.$executeRawUnsafe('TRUNCATE TABLE "audit_events"')).rejects.toThrow();
    await expect(
      client.role.update({ where: { id: protectedRoleId }, data: { name: 'compromised' } }),
    ).rejects.toThrow();
    await expect(client.role.delete({ where: { id: protectedRoleId } })).rejects.toThrow();
    await expect(client.adminUser.count({ where: { id: sentinelId } })).resolves.toBe(1);
  });

  integration(
    'enforces protected-role authority and live capability ceilings after locks',
    async () => {
      const client = requirePrisma();
      const repository = new (requireAdministrationRepository())(client);
      const managerId = await createAdmin('manager');
      const targetId = await createAdmin('manager-target');
      const concurrentTargetId = await createAdmin('manager-concurrent-target');
      const managementRoleId = generateUuidV7();
      const ownReaderRoleId = generateUuidV7();
      const walletRoleId = generateUuidV7();
      const assignedReaderRoleId = generateUuidV7();
      expect(
        (
          await repository.createRole({
            role: {
              id: managementRoleId,
              name: `manager-${randomBytes(4).toString('hex')}`,
              description: 'Non-protected management role',
              dataScope: 'ALL',
              permissionKeys: ['iam:roles:write', 'iam:admins:write'],
            },
            audit: decision('role.create', 'role', managementRoleId),
          })
        ).kind,
      ).toBe('created');
      expect(
        (
          await repository.createRole({
            role: {
              id: walletRoleId,
              name: `existing-wallet-${randomBytes(4).toString('hex')}`,
              description: 'Existing elevated wallet role',
              dataScope: 'OWN',
              permissionKeys: ['wallet:adjust'],
            },
            audit: decision('role.create', 'role', walletRoleId),
          })
        ).kind,
      ).toBe('created');
      expect(
        (
          await repository.createRole({
            role: {
              id: assignedReaderRoleId,
              name: `existing-assigned-reader-${randomBytes(4).toString('hex')}`,
              description: 'Existing wider-scope reader role',
              dataScope: 'ASSIGNED',
              permissionKeys: ['users:read'],
            },
            audit: decision('role.create', 'role', assignedReaderRoleId),
          })
        ).kind,
      ).toBe('created');
      expect(
        (
          await repository.createRole({
            role: {
              id: ownReaderRoleId,
              name: `own-reader-${randomBytes(4).toString('hex')}`,
              description: 'Own user reader',
              dataScope: 'OWN',
              permissionKeys: ['users:read'],
            },
            audit: decision('role.create', 'role', ownReaderRoleId),
          })
        ).kind,
      ).toBe('created');
      for (const roleId of [managementRoleId, ownReaderRoleId]) {
        await expect(
          repository.assignRole({
            adminId: managerId,
            roleId,
            assignedBy: rootId,
            audit: decision('admin-role.assign', 'admin', managerId),
          }),
        ).resolves.toBe('assigned');
      }
      await expect(
        repository.assignRole({
          adminId: managerId,
          roleId: protectedRoleId,
          assignedBy: managerId,
          audit: decision('admin-role.assign', 'admin', managerId, undefined, managerId),
        }),
      ).resolves.toBe('protected_role_denied');
      for (const adminId of [managerId, targetId]) {
        await expect(
          repository.assignRole({
            adminId,
            roleId: walletRoleId,
            assignedBy: managerId,
            audit: decision('admin-role.assign', 'admin', adminId, undefined, managerId),
          }),
        ).resolves.toBe('capability_exceeded');
      }
      await expect(
        repository.assignRole({
          adminId: targetId,
          roleId: assignedReaderRoleId,
          assignedBy: managerId,
          audit: decision('admin-role.assign', 'admin', targetId, undefined, managerId),
        }),
      ).resolves.toBe('capability_exceeded');
      await expect(
        repository.assignRole({
          adminId: targetId,
          roleId: ownReaderRoleId,
          assignedBy: managerId,
          audit: decision('admin-role.assign', 'admin', targetId, undefined, managerId),
        }),
      ).resolves.toBe('assigned');
      await expect(
        repository.assignRole({
          adminId: targetId,
          roleId: protectedRoleId,
          assignedBy: managerId,
          audit: decision('admin-role.assign', 'admin', targetId, undefined, managerId),
        }),
      ).resolves.toBe('protected_role_denied');

      const missingCapabilityId = generateUuidV7();
      await expect(
        repository.createRole({
          role: {
            id: missingCapabilityId,
            name: `wallet-${randomBytes(4).toString('hex')}`,
            description: 'Escalating role',
            dataScope: 'OWN',
            permissionKeys: ['wallet:adjust'],
          },
          audit: decision('role.create', 'role', missingCapabilityId, undefined, managerId),
        }),
      ).resolves.toEqual({ kind: 'capability_exceeded' });
      const wrongScopeId = generateUuidV7();
      await expect(
        repository.createRole({
          role: {
            id: wrongScopeId,
            name: `assigned-reader-${randomBytes(4).toString('hex')}`,
            description: 'Wrong-scope role',
            dataScope: 'ASSIGNED',
            permissionKeys: ['users:read'],
          },
          audit: decision('role.create', 'role', wrongScopeId, undefined, managerId),
        }),
      ).resolves.toEqual({ kind: 'capability_exceeded' });
      const legalSubsetId = generateUuidV7();
      await expect(
        repository.createRole({
          role: {
            id: legalSubsetId,
            name: `child-own-reader-${randomBytes(4).toString('hex')}`,
            description: 'Legal delegated subset',
            dataScope: 'OWN',
            permissionKeys: ['users:read'],
          },
          audit: decision('role.create', 'role', legalSubsetId, undefined, managerId),
        }),
      ).resolves.toMatchObject({ kind: 'created' });

      const barrier = new PgClient({
        connectionString: databaseUrl(requireBaseUrl(), isolatedDatabaseName),
      });
      try {
        await barrier.connect();
        await barrier.query('BEGIN');
        await barrier.query(
          "SELECT pg_advisory_xact_lock(hashtextextended('iam:authorization-graph', 0))",
        );
        const blockedMutation = repository.assignRole({
          adminId: concurrentTargetId,
          roleId: ownReaderRoleId,
          assignedBy: managerId,
          audit: decision('admin-role.assign', 'admin', concurrentTargetId, undefined, managerId),
        });
        await barrier.query('DELETE FROM "admin_roles" WHERE "admin_id" = $1::uuid', [managerId]);
        await barrier.query('COMMIT');
        await expect(blockedMutation).resolves.toBe('actor_denied');
      } finally {
        await barrier.query('ROLLBACK').catch(() => undefined);
        await barrier.end();
      }
    },
  );

  integration('serializes concurrent last-super-admin revoke and Task4 disable paths', async () => {
    const client = requirePrisma();
    const repository = new (requireAdministrationRepository())(client);
    const revokeResults = await Promise.all([
      repository.revokeRole({
        adminId: rootId,
        roleId: protectedRoleId,
        expectedAssignment: true,
        audit: decision('admin-role.revoke', 'admin', rootId),
      }),
      repository.revokeRole({
        adminId: secondId,
        roleId: protectedRoleId,
        expectedAssignment: true,
        audit: decision('admin-role.revoke', 'admin', secondId, undefined, secondId),
      }),
    ]);
    expect(revokeResults.filter((result) => result === 'revoked')).toHaveLength(1);
    expect(['actor_denied', 'last_super_admin']).toContain(
      revokeResults.find((result) => result !== 'revoked'),
    );
    const removedAdminId = revokeResults[0] === 'revoked' ? rootId : secondId;
    const survivingAdminId = removedAdminId === rootId ? secondId : rootId;
    await repository.assignRole({
      adminId: removedAdminId,
      roleId: protectedRoleId,
      assignedBy: survivingAdminId,
      audit: decision('admin-role.assign', 'admin', removedAdminId, undefined, survivingAdminId),
    });

    const task4Repository = new PrismaAdminAuthRepository(client);
    const disabled = await Promise.all([
      task4Repository.disableAdminAccess(rootId, new Date(0)),
      task4Repository.disableAdminAccess(secondId, new Date(0)),
    ]);
    expect([...disabled].sort()).toEqual(['disabled', 'last_super_admin']);
    const disabledAdminId = disabled[0] === 'disabled' ? rootId : secondId;
    const activeAdminId = disabledAdminId === rootId ? secondId : rootId;
    const replayActiveSessionId = generateUuidV7();
    const replayPendingSessionId = generateUuidV7();
    const replayChallengeId = generateUuidV7();
    await client.adminSession.createMany({
      data: [
        {
          id: replayActiveSessionId,
          adminId: disabledAdminId,
          familyId: generateUuidV7(),
          refreshTokenDigest: randomBytes(32).toString('hex'),
          deviceName: 'Disabled replay active',
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
          status: 'ACTIVE',
        },
        {
          id: replayPendingSessionId,
          adminId: disabledAdminId,
          familyId: generateUuidV7(),
          refreshTokenDigest: randomBytes(32).toString('hex'),
          deviceName: 'Disabled replay pending',
          expiresAt: new Date('2026-10-01T00:00:00.000Z'),
          status: 'PENDING',
          pendingKind: 'MFA_RECOVERY',
          pendingChallengeId: replayChallengeId,
          pendingExpiresAt: new Date('2026-09-01T12:05:00.000Z'),
        },
      ],
    });
    await client.mfaChallenge.create({
      data: {
        id: replayChallengeId,
        adminId: disabledAdminId,
        challengeDigest: randomBytes(32).toString('hex'),
        expiresAt: new Date('2026-09-01T12:05:00.000Z'),
        reservedSessionId: replayPendingSessionId,
        reservedUntil: new Date('2026-09-01T12:02:00.000Z'),
      },
    });
    await expect(task4Repository.disableAdminAccess(disabledAdminId, new Date(0))).resolves.toBe(
      'disabled',
    );
    const replayActive = await client.adminSession.findUniqueOrThrow({
      where: { id: replayActiveSessionId },
    });
    expect(replayActive.revokedAt).toBeInstanceOf(Date);
    const replayPending = await client.adminSession.findUniqueOrThrow({
      where: { id: replayPendingSessionId },
    });
    expect(replayPending.status).toBe('CANCELLED');
    expect(replayPending.revokedAt).toBeInstanceOf(Date);
    await expect(
      client.mfaChallenge.findUniqueOrThrow({ where: { id: replayChallengeId } }),
    ).resolves.toMatchObject({ reservedSessionId: null, reservedUntil: null });
    await expect(
      repository.revokeRole({
        adminId: disabledAdminId,
        roleId: protectedRoleId,
        expectedAssignment: true,
        audit: decision('admin-role.revoke', 'admin', disabledAdminId, undefined, activeAdminId),
      }),
    ).resolves.toBe('revoked');
    await expect(
      client.adminUser.count({
        where: {
          status: 'ACTIVE',
          roles: { some: { role: { protected: true } } },
        },
      }),
    ).resolves.toBe(1);
    await expect(client.adminUser.count({ where: { id: sentinelId } })).resolves.toBe(1);
  });
});

async function createAdmin(label: string): Promise<string> {
  const id = generateUuidV7();
  await requirePrisma().adminUser.create({
    data: {
      id,
      email: `iam-rbac-${label}-${id}@example.test`,
      passwordHash: '$argon2id$v=19$m=65536,p=1,t=3$fixture$fixture',
    },
  });
  return id;
}

async function seedPermission(key: string): Promise<void> {
  await requirePrisma().permission.create({
    data: { id: generateUuidV7(), key, description: `Integration permission ${key}` },
  });
}

function decision(
  action: string,
  resourceType: string,
  resourceId: string,
  after?: unknown,
  actorId: string | null = rootId || null,
): AuditDecisionInput {
  auditSequence += 1;
  return {
    id: generateUuidV7(),
    action,
    resourceType,
    resourceId,
    outcome: 'SUCCESS',
    ...(after === undefined ? {} : { after }),
    context: {
      actorId,
      ipAddress: '127.0.0.1',
      userAgent: 'iam-rbac-integration',
      traceId: auditSequence.toString(16).padStart(32, '0'),
      correlationId: generateUuidV7(),
      occurredAt: new Date(Date.UTC(2026, 8, 1, 12, 0, auditSequence)),
    },
  };
}

function requireBaseUrl(): string {
  if (!baseDatabaseUrl) throw new Error('EXPECTED_BASE_DATABASE_URL');
  return baseDatabaseUrl;
}

function databaseUrl(base: string, databaseName: string): string {
  const value = new URL(base);
  value.pathname = `/${databaseName}`;
  value.search = '';
  return value.toString();
}

function requirePrisma(): PrismaClient {
  if (!prisma) throw new Error('EXPECTED_PRISMA');
  return prisma;
}

function requireAdministrationRepository() {
  if (!AdministrationRepository) throw new Error('EXPECTED_ADMINISTRATION_REPOSITORY');
  return AdministrationRepository;
}

async function cleanupIsolatedDatabase(verifySentinel: boolean): Promise<void> {
  try {
    if (prisma) {
      const connected = prisma;
      try {
        if (verifySentinel) {
          await expect(connected.adminUser.count({ where: { id: sentinelId } })).resolves.toBe(1);
        }
      } finally {
        prisma = null;
        await connected.$disconnect();
      }
    }
  } finally {
    if (administrativeClient) {
      const administrative = administrativeClient;
      try {
        if (isolatedDatabaseCreated) {
          await administrative.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
            [isolatedDatabaseName],
          );
          await administrative.query(`DROP DATABASE "${isolatedDatabaseName}"`);
          isolatedDatabaseCreated = false;
        }
      } finally {
        administrativeClient = null;
        await administrative.end();
      }
    }
  }
}
