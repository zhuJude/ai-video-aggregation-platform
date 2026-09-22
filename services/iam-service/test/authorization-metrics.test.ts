import { describe, expect, it, vi } from 'vitest';
import { IamAdministrationService } from '../src/application/iam-administration.service.js';
import type {
  IamAdministrationRepository,
  RoleRecord,
} from '../src/application/iam-administration.repository.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';

const actorId = generateUuidV7();
const adminId = generateUuidV7();
const roleId = generateUuidV7();
const role: RoleRecord = {
  id: roleId,
  name: 'bounded-role',
  description: 'Bounded test role',
  dataScope: 'OWN',
  version: 1,
  protected: false,
  permissionKeys: [],
};

describe('IAM authorization denial metrics', () => {
  const deniedCases = [
    {
      name: 'locked actor revalidation',
      code: 'ADMIN_AUTHORIZATION_DENIED',
      override: { createRole: () => Promise.resolve({ kind: 'actor_denied' as const }) },
      run: (service: IamAdministrationService) => service.createRole(roleInput()),
    },
    {
      name: 'capability ceiling revalidation',
      code: 'CAPABILITY_CEILING_EXCEEDED',
      override: { createRole: () => Promise.resolve({ kind: 'capability_exceeded' as const }) },
      run: (service: IamAdministrationService) => service.createRole(roleInput()),
    },
    {
      name: 'protected role mutation',
      code: 'PROTECTED_ROLE',
      override: { updateRole: () => Promise.resolve({ kind: 'protected' as const }) },
      run: (service: IamAdministrationService) =>
        service.updateRole({ roleId, expectedVersion: 1, ...roleInput() }),
    },
    {
      name: 'protected role assignment',
      code: 'PROTECTED_ROLE_ASSIGNMENT_DENIED',
      override: { assignRole: () => Promise.resolve('protected_role_denied' as const) },
      run: (service: IamAdministrationService) =>
        service.assignRole({ adminId, roleId, context: context(actorId) }),
    },
    {
      name: 'last super administrator protection',
      code: 'LAST_SUPER_ADMIN_PROTECTED',
      override: { disableAdmin: () => Promise.resolve('last_super_admin' as const) },
      run: (service: IamAdministrationService) =>
        service.disableAdmin({ adminId, context: context(actorId) }),
    },
  ] as const;

  it.each(deniedCases)('counts $name exactly once', async ({ code, override, run }) => {
    const fixture = createFixture(override);
    await expect(run(fixture.service)).rejects.toMatchObject({ code });
    expect(fixture.increment).toHaveBeenCalledTimes(1);
    expect(fixture.increment).toHaveBeenCalledWith('iam_authorization_denials_total');
  });

  it('counts pre-service can denial and a null principal once each', async () => {
    const missingSubject = createFixture({ loadAuthorizationSubject: () => Promise.resolve(null) });
    await expect(missingSubject.service.listPermissions(context(actorId))).rejects.toMatchObject({
      code: 'ADMIN_AUTHORIZATION_DENIED',
    });
    expect(missingSubject.increment).toHaveBeenCalledTimes(1);

    const nullPrincipal = createFixture();
    await expect(nullPrincipal.service.listPermissions(context(null))).rejects.toMatchObject({
      code: 'ADMIN_AUTHORIZATION_DENIED',
    });
    expect(nullPrincipal.increment).toHaveBeenCalledTimes(1);
  });

  it('counts the denial decision once even when its audit append fails', async () => {
    const fixture = createFixture({
      loadAuthorizationSubject: () => Promise.resolve(null),
      appendAudit: () => Promise.reject(new Error('AUDIT_UNAVAILABLE')),
    });
    await expect(fixture.service.listPermissions(context(actorId))).rejects.toThrow(
      'AUDIT_UNAVAILABLE',
    );
    expect(fixture.increment).toHaveBeenCalledTimes(1);
    expect(fixture.increment).toHaveBeenCalledWith('iam_authorization_denials_total');
  });

  it('does not count successful or unknown infrastructure outcomes', async () => {
    const success = createFixture();
    await expect(success.service.createRole(roleInput())).resolves.toMatchObject({ id: roleId });
    expect(success.increment).not.toHaveBeenCalled();

    const infrastructure = createFixture({
      createRole: () => Promise.reject(new Error('DATABASE_UNAVAILABLE')),
    });
    await expect(infrastructure.service.createRole(roleInput())).rejects.toThrow(
      'DATABASE_UNAVAILABLE',
    );
    expect(infrastructure.increment).not.toHaveBeenCalled();
  });
});

function createFixture(overrides: Partial<IamAdministrationRepository> = {}) {
  const increment = vi.fn();
  const repository = {
    appendAudit: () => Promise.resolve(),
    loadAuthorizationSubject: () =>
      Promise.resolve({
        adminId: actorId,
        grants: [
          { permission: 'iam:roles:write', dataScope: 'ALL' as const },
          { permission: 'iam:admins:write', dataScope: 'ALL' as const },
          { permission: 'iam:permissions:read', dataScope: 'ALL' as const },
        ],
      }),
    createRole: () => Promise.resolve({ kind: 'created' as const, role }),
    updateRole: () => Promise.resolve({ kind: 'updated' as const, role }),
    assignRole: () => Promise.resolve('assigned' as const),
    disableAdmin: () => Promise.resolve('disabled' as const),
    ...overrides,
  } as unknown as IamAdministrationRepository;
  return {
    increment,
    service: new IamAdministrationService({
      repository,
      bootstrapAuthorizer: { authorize: () => Promise.resolve(false) },
      uuidV7: generateUuidV7,
      metrics: { increment },
    }),
  };
}

function roleInput() {
  return {
    name: role.name,
    description: role.description,
    dataScope: role.dataScope,
    permissionKeys: role.permissionKeys,
    context: context(actorId),
  };
}

function context(id: string | null) {
  return {
    actorId: id,
    ipAddress: '127.0.0.1',
    userAgent: 'authorization-metrics-test',
    traceId: 'a'.repeat(32),
    correlationId: generateUuidV7(),
    occurredAt: new Date('2026-09-02T00:00:00.000Z'),
  };
}
