import { describe, expect, it } from 'vitest';

import { MemoryIamAdministrationRepository } from '../src/adapters/memory-iam-administration.repository.js';
import { MemoryAdminAuthRepository } from '../src/adapters/memory-admin-auth.repository.js';
import { MemoryAdminAccessCoordinator } from '../src/adapters/memory-admin-access.coordinator.js';
import { IamAdministrationService } from '../src/application/iam-administration.service.js';
import { redactAuditValue, validateManagementContext } from '../src/application/audit.service.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';

const now = new Date('2026-09-01T10:00:00.000Z');

describe('IAM role administration and audit', () => {
  it('deeply redacts sensitive fields without mutating the source', () => {
    const source = {
      email: 'visible@example.test',
      nested: {
        passwordHash: 'argon-secret',
        values: [{ totpSecretCiphertext: 'ciphertext' }, { label: 'visible' }],
      },
      refresh_token: 'refresh-secret',
    };
    expect(redactAuditValue(source)).toEqual({
      email: 'visible@example.test',
      nested: {
        passwordHash: '[REDACTED]',
        values: [{ totpSecretCiphertext: '[REDACTED]' }, { label: 'visible' }],
      },
      refresh_token: '[REDACTED]',
    });
    expect(source.nested.passwordHash).toBe('argon-secret');
    expect(redactAuditValue([undefined, Symbol('marker'), () => 'unsafe'])).toEqual([
      '[UNDEFINED]',
      'marker',
      '[FUNCTION]',
    ]);
    expect(() => {
      validateManagementContext({ ...systemContext(), ipAddress: '' });
    }).toThrow(expect.objectContaining({ code: 'INVALID_AUDIT_CONTEXT' }));
    expect(() => {
      validateManagementContext({ ...systemContext(), occurredAt: new Date(Number.NaN) });
    }).toThrow(expect.objectContaining({ code: 'INVALID_AUDIT_CONTEXT' }));
  });

  it('requires bootstrap proof and creates exactly one protected super administrator', async () => {
    const rootId = generateUuidV7();
    const secondId = generateUuidV7();
    const { service } = fixture([rootId, secondId]);

    await expect(
      service.bootstrapSuperAdmin({ adminId: rootId, proof: 'wrong', context: systemContext() }),
    ).rejects.toMatchObject({ code: 'INVALID_BOOTSTRAP_PROOF' });
    await expect(
      service.bootstrapSuperAdmin({ adminId: rootId, proof: 'bootstrap-proof-2026', context: systemContext() }),
    ).resolves.toMatchObject({ protected: true, dataScope: 'ALL' });
    await expect(
      service.bootstrapSuperAdmin({ adminId: secondId, proof: 'bootstrap-proof-2026', context: systemContext() }),
    ).rejects.toMatchObject({ code: 'SUPER_ADMIN_ALREADY_BOOTSTRAPPED' });
  });

  it('uses optimistic role versions and audits success and conflict without secrets', async () => {
    const rootId = generateUuidV7();
    const { service } = fixture([rootId]);
    await bootstrap(service, rootId);
    const role = await service.createRole({
      name: 'support-operator',
      description: 'Support operations',
      dataScope: 'ASSIGNED',
      permissionKeys: ['users:read'],
      context: actorContext(rootId),
    });
    await expect(
      service.updateRole({
        roleId: role.id,
        expectedVersion: role.version,
        name: 'support-operator',
        description: 'Updated',
        dataScope: 'OWN',
        permissionKeys: ['users:read', 'audit:read'],
        context: actorContext(rootId),
      }),
    ).resolves.toMatchObject({ version: 2, dataScope: 'OWN' });
    await expect(
      service.updateRole({
        roleId: role.id,
        expectedVersion: role.version,
        name: 'stale-update',
        description: 'contains password=secret',
        dataScope: 'ALL',
        permissionKeys: [],
        context: actorContext(rootId),
      }),
    ).rejects.toMatchObject({ code: 'ROLE_VERSION_CONFLICT' });

    const audit = await service.queryAudit({
      context: actorContext(rootId),
      limit: 20,
      resourceType: 'role',
      resourceId: role.id,
    });
    expect(audit.items.map((event) => event.outcome)).toEqual(
      expect.arrayContaining(['SUCCESS', 'DENIED']),
    );
    expect(JSON.stringify(audit.items)).not.toContain('password=secret');
    const mutableCopy = audit.items.find((event) => event.outcome === 'SUCCESS')?.after;
    if (!mutableCopy || typeof mutableCopy !== 'object' || Array.isArray(mutableCopy)) {
      throw new Error('EXPECTED_AUDIT_AFTER');
    }
    (mutableCopy as Record<string, unknown>)['description'] = 'tampered-by-caller';
    const reread = await service.queryAudit({
      context: actorContext(rootId),
      limit: 20,
      resourceType: 'role',
      resourceId: role.id,
    });
    expect(JSON.stringify(reread.items)).not.toContain('tampered-by-caller');
  });

  it('prevents removing or disabling the last active super administrator', async () => {
    const rootId = generateUuidV7();
    const secondId = generateUuidV7();
    const { service } = fixture([rootId, secondId]);
    const protectedRole = await bootstrap(service, rootId);

    await expect(
      service.revokeRole({
        adminId: rootId,
        roleId: protectedRole.id,
        expectedAssignment: true,
        context: actorContext(rootId),
      }),
    ).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN_PROTECTED' });
    await expect(
      service.disableAdmin({ adminId: rootId, context: actorContext(rootId) }),
    ).rejects.toMatchObject({ code: 'LAST_SUPER_ADMIN_PROTECTED' });

    await service.assignRole({
      adminId: secondId,
      roleId: protectedRole.id,
      context: actorContext(rootId),
    });
    await expect(
      service.disableAdmin({ adminId: rootId, context: actorContext(secondId) }),
    ).resolves.toBe('disabled');
  });

  it('shares live super-admin assignment state with the Task4 memory disable primitive', async () => {
    const rootId = generateUuidV7();
    const secondId = generateUuidV7();
    const { repository, service, auth } = fixture([rootId, secondId]);
    const protectedRole = await bootstrap(service, rootId);

    await expect(auth.disableAdminAccess(rootId, now)).resolves.toBe('last_super_admin');
    await service.assignRole({
      adminId: secondId,
      roleId: protectedRole.id,
      context: actorContext(rootId),
    });
    const activeChallenge = await pendingSession(auth, rootId, 'active');
    const active = await auth.finalizeMfaSession({
      adminId: rootId,
      sessionId: activeChallenge.sessionId,
      familyId: activeChallenge.familyId,
      challengeDigest: activeChallenge.challengeDigest,
      now,
    });
    expect(active?.status).toBe('ACTIVE');
    const pending = await pendingSession(auth, rootId, 'pending', 2);

    await expect(
      service.disableAdmin({ adminId: rootId, context: actorContext(secondId) }),
    ).resolves.toBe('disabled');
    await expect(auth.disableAdminAccess(rootId, now)).resolves.toBe('disabled');
    await expect(auth.findAdminById(rootId)).resolves.toMatchObject({ status: 'DISABLED' });
    await expect(
      auth.rotateSession({
        presentedDigest: activeChallenge.refreshTokenDigest,
        now,
        successor: {
          id: generateUuidV7(),
          refreshTokenDigest: 'successor-digest',
          expiresAt: new Date(now.getTime() + 60_000),
          createdAt: now,
        },
      }),
    ).resolves.toMatchObject({ kind: 'revoked' });
    await expect(auth.finalizeMfaSession({
      adminId: rootId,
      sessionId: pending.sessionId,
      familyId: pending.familyId,
      challengeDigest: pending.challengeDigest,
      now,
    })).resolves.toBeNull();
    await expect(
      service.revokeRole({
        adminId: rootId,
        roleId: protectedRole.id,
        expectedAssignment: true,
        context: actorContext(secondId),
      }),
    ).resolves.toBe('revoked');
    await expect(repository.loadAuthorizationSubject(rootId)).resolves.toBeNull();
  });

  it('fails closed when the memory auth participant is not attached', async () => {
    const rootId = generateUuidV7();
    const coordinator = new MemoryAdminAccessCoordinator();
    const repository = new MemoryIamAdministrationRepository({
      admins: [{ id: rootId, email: 'detached-root@example.test', status: 'ACTIVE' }],
      permissions: [
        { id: generateUuidV7(), key: 'iam:admins:write', description: 'Manage admins' },
      ],
    }, coordinator);
    const service = new IamAdministrationService({
      repository,
      bootstrapAuthorizer: { authorize: () => Promise.resolve(true) },
      now: () => now,
      uuidV7: generateUuidV7,
    });
    await bootstrap(service, rootId);
    await expect(
      service.disableAdmin({ adminId: rootId, context: actorContext(rootId) }),
    ).rejects.toMatchObject({ code: 'ADMIN_DISABLE_COORDINATOR_UNAVAILABLE' });
    await expect(repository.loadAuthorizationSubject(rootId)).resolves.not.toBeNull();
  });

  it('assigns and revokes roles and enforces bounded audit pagination', async () => {
    const rootId = generateUuidV7();
    const operatorId = generateUuidV7();
    const { service } = fixture([rootId, operatorId]);
    await bootstrap(service, rootId);
    const role = await service.createRole({
      name: 'auditor',
      description: 'Reads audit',
      dataScope: 'ALL',
      permissionKeys: ['audit:read'],
      context: actorContext(rootId),
    });
    await expect(
      service.assignRole({ adminId: operatorId, roleId: role.id, context: actorContext(rootId) }),
    ).resolves.toBe('assigned');
    await expect(
      service.revokeRole({
        adminId: operatorId,
        roleId: role.id,
        expectedAssignment: true,
        context: actorContext(rootId),
      }),
    ).resolves.toBe('revoked');
    await expect(
      service.queryAudit({ context: actorContext(rootId), limit: 101 }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIT_QUERY' });
    await expect(
      service.queryAudit({
        context: actorContext(rootId),
        cursor: Buffer.from('2026-09-01T00:00:00.000Z|not-a-uuid').toString('base64url'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_AUDIT_QUERY' });
    const rolePage = await service.listRoles({ context: actorContext(rootId), limit: 1 });
    expect(rolePage.items[0]?.name).toBe('auditor');
    expect(typeof rolePage.nextCursor).toBe('string');
    await expect(service.listRoles({ context: actorContext(rootId), limit: 101 })).rejects.toMatchObject({
      code: 'INVALID_ROLE_QUERY',
    });
  });

  it('enforces protected-role actors and a live permission/data-scope capability ceiling', async () => {
    const rootId = generateUuidV7();
    const managerId = generateUuidV7();
    const targetId = generateUuidV7();
    const { repository, service } = fixture([rootId, managerId, targetId]);
    const protectedRole = await bootstrap(service, rootId);
    const managementRole = await service.createRole({
      name: 'role-manager',
      description: 'Role manager without super-admin authority',
      dataScope: 'ALL',
      permissionKeys: ['iam:admins:write', 'iam:roles:write'],
      context: actorContext(rootId),
    });
    const ownReader = await service.createRole({
      name: 'own-reader',
      description: 'Own-scope reader capability',
      dataScope: 'OWN',
      permissionKeys: ['users:read'],
      context: actorContext(rootId),
    });
    const walletRole = await service.createRole({
      name: 'existing-wallet-operator',
      description: 'Existing elevated role',
      dataScope: 'OWN',
      permissionKeys: ['wallet:adjust'],
      context: actorContext(rootId),
    });
    const assignedReader = await service.createRole({
      name: 'existing-assigned-reader',
      description: 'Existing wider-scope reader',
      dataScope: 'ASSIGNED',
      permissionKeys: ['users:read'],
      context: actorContext(rootId),
    });
    await service.assignRole({
      adminId: managerId,
      roleId: managementRole.id,
      context: actorContext(rootId),
    });
    await service.assignRole({
      adminId: managerId,
      roleId: ownReader.id,
      context: actorContext(rootId),
    });
    await expect(repository.assignRole({
      adminId: targetId,
      roleId: ownReader.id,
      assignedBy: targetId,
      audit: repositoryDecision(managerId, targetId),
    })).resolves.toBe('actor_denied');
    await expect(
      service.assignRole({
        adminId: managerId,
        roleId: walletRole.id,
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CEILING_EXCEEDED' });
    await expect(
      service.assignRole({
        adminId: targetId,
        roleId: walletRole.id,
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CEILING_EXCEEDED' });
    await expect(
      service.assignRole({
        adminId: targetId,
        roleId: assignedReader.id,
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CEILING_EXCEEDED' });
    await expect(
      service.assignRole({
        adminId: targetId,
        roleId: ownReader.id,
        context: actorContext(managerId),
      }),
    ).resolves.toBe('assigned');
    await expect(
      service.assignRole({
        adminId: targetId,
        roleId: protectedRole.id,
        context: actorContext(rootId),
      }),
    ).resolves.toBe('assigned');

    await expect(
      service.assignRole({
        adminId: managerId,
        roleId: protectedRole.id,
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'PROTECTED_ROLE_ASSIGNMENT_DENIED' });
    await expect(
      service.assignRole({
        adminId: targetId,
        roleId: protectedRole.id,
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'PROTECTED_ROLE_ASSIGNMENT_DENIED' });
    await expect(
      service.revokeRole({
        adminId: rootId,
        roleId: protectedRole.id,
        expectedAssignment: true,
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'PROTECTED_ROLE_ASSIGNMENT_DENIED' });
    await expect(
      service.createRole({
        name: 'wallet-operator',
        description: 'Unauthorized wallet permission',
        dataScope: 'OWN',
        permissionKeys: ['wallet:adjust'],
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CEILING_EXCEEDED' });
    await expect(
      service.createRole({
        name: 'assigned-reader',
        description: 'Scope widening attempt',
        dataScope: 'ASSIGNED',
        permissionKeys: ['users:read'],
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CEILING_EXCEEDED' });
    const child = await service.createRole({
      name: 'child-own-reader',
      description: 'Legal delegated subset',
      dataScope: 'OWN',
      permissionKeys: ['users:read'],
      context: actorContext(managerId),
    });
    expect(child).toMatchObject({ dataScope: 'OWN', permissionKeys: ['users:read'] });
    await expect(
      service.updateRole({
        roleId: child.id,
        expectedVersion: child.version,
        name: child.name,
        description: 'Escalating existing role',
        dataScope: 'OWN',
        permissionKeys: ['users:read', 'wallet:adjust'],
        context: actorContext(managerId),
      }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_CEILING_EXCEEDED' });
    await expect(
      service.createRole({
        name: 'second-child-own-reader',
        description: 'Second legal delegated subset',
        dataScope: 'OWN',
        permissionKeys: ['users:read'],
        context: actorContext(managerId),
      }),
    ).resolves.toMatchObject({ dataScope: 'OWN', permissionKeys: ['users:read'] });
  });
});

function fixture(adminIds: readonly string[]) {
  const coordinator = new MemoryAdminAccessCoordinator();
  const repository = new MemoryIamAdministrationRepository({
    admins: adminIds.map((id, index) => ({
      id,
      email: `admin-${String(index)}@example.test`,
      status: 'ACTIVE' as const,
    })),
    permissions: [
      { id: generateUuidV7(), key: 'iam:roles:write', description: 'Manage roles' },
      { id: generateUuidV7(), key: 'iam:roles:read', description: 'Read roles' },
      { id: generateUuidV7(), key: 'iam:admins:write', description: 'Manage admins' },
      { id: generateUuidV7(), key: 'iam:permissions:read', description: 'Read permissions' },
      { id: generateUuidV7(), key: 'audit:read', description: 'Read audit' },
      { id: generateUuidV7(), key: 'users:read', description: 'Read users' },
      { id: generateUuidV7(), key: 'wallet:adjust', description: 'Adjust wallets' },
    ],
  }, coordinator);
  const auth = new MemoryAdminAuthRepository(
    adminIds.map(adminAuthRecord),
    coordinator,
  );
  const service = new IamAdministrationService({
    repository,
    bootstrapAuthorizer: {
      authorize: (proof) => Promise.resolve(proof === 'bootstrap-proof-2026'),
    },
    now: () => now,
    uuidV7: generateUuidV7,
  });
  return { repository, service, auth };
}

function bootstrap(service: IamAdministrationService, adminId: string) {
  return service.bootstrapSuperAdmin({
    adminId,
    proof: 'bootstrap-proof-2026',
    context: systemContext(),
  });
}

function systemContext() {
  return {
    actorId: null,
    ipAddress: '127.0.0.1',
    userAgent: 'iam-bootstrap-test',
    traceId: 'a'.repeat(32),
    correlationId: generateUuidV7(),
    occurredAt: now,
  };
}

function actorContext(actorId: string) {
  return { ...systemContext(), actorId, traceId: 'b'.repeat(32) };
}

function repositoryDecision(actorId: string, resourceId: string) {
  return {
    id: generateUuidV7(),
    action: 'admin-role.assign',
    resourceType: 'admin',
    resourceId,
    outcome: 'SUCCESS' as const,
    context: actorContext(actorId),
  };
}

function adminAuthRecord(id: string) {
  return {
    id,
    email: `${id}@example.test`,
    passwordHash: 'hash',
    status: 'ACTIVE' as const,
    mfaEnabled: true,
    pendingTotpSecretCiphertext: null,
    totpSecretCiphertext: 'test-ciphertext',
    lastTotpTimeStep: null,
    recoveryGeneration: 'test-generation',
    mfaFailureCount: 0,
    mfaFailureWindowStartedAt: null,
    mfaLockedUntil: null,
  };
}

async function pendingSession(
  auth: MemoryAdminAuthRepository,
  adminId: string,
  label: string,
  timeStep = 1,
) {
  const challengeId = generateUuidV7();
  const challengeDigest = `${label}-${generateUuidV7()}`;
  const sessionId = generateUuidV7();
  const familyId = generateUuidV7();
  const refreshTokenDigest = `${label}-refresh-${generateUuidV7()}`;
  await expect(auth.createMfaChallenge({
    id: challengeId,
    adminId,
    challengeDigest,
    expiresAt: new Date(now.getTime() + 5 * 60_000),
    createdAt: now,
  })).resolves.toBe('created');
  await expect(auth.completeTotpChallenge({
    challengeDigest,
    now,
    maxAttempts: 5,
    failureWindowMs: 5 * 60_000,
    lockDurationMs: 10 * 60_000,
    timeStep,
    session: {
      id: sessionId,
      adminId,
      familyId,
      refreshTokenDigest,
      deviceName: label,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    },
  })).resolves.toMatchObject({ kind: 'authenticated' });
  return { challengeDigest, sessionId, familyId, refreshTokenDigest };
}
