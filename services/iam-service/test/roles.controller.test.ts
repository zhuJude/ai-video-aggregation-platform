import { describe, expect, it, vi } from 'vitest';

import * as rolesModule from '../src/http/roles.controller.js';
import { IamAdminGuard, RolesController } from '../src/http/roles.controller.js';
import { generateUuidV7 } from '../src/domain/uuid-v7.js';

describe('RolesController', () => {
  it('derives immutable audit context from the trusted principal and ingress headers', async () => {
    const createRole = vi.fn().mockResolvedValue({ id: generateUuidV7(), version: 1 });
    const controller = new RolesController({ createRole } as never);
    const actorId = generateUuidV7();
    const ingress = await authenticatedRequest(actorId);

    await controller.createRole(
      ingress,
      {
        name: 'support-operator',
        description: 'Support operator',
        dataScope: 'ASSIGNED',
        permissionKeys: ['users:read'],
      },
    );

    const call = createRole.mock.calls[0]?.[0] as
      | { readonly name: string; readonly context: { readonly actorId: string; readonly ipAddress: string; readonly traceId: string } }
      | undefined;
    expect(call).toEqual(expect.objectContaining({ name: 'support-operator' }));
    expect(call?.context.actorId).toBe(actorId);
    expect(call?.context.ipAddress).toBe('127.0.0.1');
    expect(call?.context.traceId).toBe('a'.repeat(32));
  });

  it('rejects forged principals and over-posted role DTOs without exporting a mint path', async () => {
    const controller = new RolesController({ createRole: vi.fn() } as never);
    const trusted = await authenticatedRequest();
    expect((rolesModule as Record<string, unknown>)['AuthenticatedAdmin']).toBeUndefined();
    expect((rolesModule as Record<string, unknown>)['mintPrincipal']).toBeUndefined();
    expect((rolesModule as Record<string, unknown>)['bindVerifiedRequest']).toBeUndefined();
    expect(() =>
      controller.createRole(
        { ...request(), admin: { adminId: generateUuidV7(), sessionId: generateUuidV7() } } as never,
        {
          name: 'support-operator',
          description: 'Support operator',
          dataScope: 'ALL',
          permissionKeys: [],
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'UNTRUSTED_ADMIN_PRINCIPAL' }));
    expect(() =>
      controller.createRole(
        trusted,
        {
          name: 'support-operator',
          description: 'Support operator',
          dataScope: 'ALL',
          permissionKeys: [],
          protected: true,
        },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_REQUEST' }));
  });

  it('maps all bounded management endpoints without accepting actor identity from DTOs', async () => {
    const methods = {
      listPermissions: vi.fn().mockResolvedValue([]),
      listRoles: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
      updateRole: vi.fn().mockResolvedValue({ version: 2 }),
      deleteRole: vi.fn().mockResolvedValue(undefined),
      assignRole: vi.fn().mockResolvedValue('assigned'),
      revokeRole: vi.fn().mockResolvedValue('revoked'),
      disableAdmin: vi.fn().mockResolvedValue('disabled'),
      queryAudit: vi.fn().mockResolvedValue({ items: [], nextCursor: null }),
    };
    const controller = new RolesController(methods as never);
    const actorId = generateUuidV7();
    const target = generateUuidV7();
    const roleId = generateUuidV7();
    const ingress = await authenticatedRequest(actorId);

    await controller.listPermissions(ingress);
    await controller.listRoles(ingress, { cursor: 'YWJjfDE', limit: '2' });
    await controller.updateRole(ingress, roleId, {
      name: 'support-operator',
      description: 'Updated support operator',
      dataScope: 'OWN',
      permissionKeys: ['users:read'],
      expectedVersion: 1,
    });
    await controller.deleteRole(ingress, roleId, '2');
    await controller.assignRole(ingress, target, roleId);
    await controller.revokeRole(ingress, target, roleId);
    await controller.disableAdmin(ingress, target);
    await controller.queryAudit(ingress, {
      actorId: target,
      action: 'role.update',
      resourceType: 'role',
      resourceId: roleId,
      outcome: 'SUCCESS',
      from: '2026-09-01T00:00:00.000Z',
      to: '2026-09-02T00:00:00.000Z',
      cursor: 'YWJjfDE',
      limit: '10',
    });

    expect(methods.assignRole.mock.calls[0]?.[0]).toMatchObject({
      adminId: target,
      roleId,
      context: { actorId },
    });
    expect(methods.queryAudit.mock.calls[0]?.[0]).toMatchObject({
      actorId: target,
      outcome: 'SUCCESS',
      limit: 10,
    });
  });

  it('authenticates bearer tokens through the verifier and brands the request principal', async () => {
    const adminId = generateUuidV7();
    const sessionId = generateUuidV7();
    const requestState: Record<string, unknown> = {
      headers: { authorization: 'Bearer valid.token' },
      ip: '127.0.0.1',
    };
    const guard = new IamAdminGuard({
      verify: (token) =>
        token === 'valid.token'
          ? Promise.resolve({ adminId, sessionId })
          : Promise.reject(new Error('invalid')),
    });
    const execution = {
      switchToHttp: () => ({ getRequest: () => requestState }),
    };
    await expect(guard.canActivate(execution as never)).resolves.toBe(true);
    expect(requestState['admin']).toBeUndefined();

    const missing = new IamAdminGuard({ verify: vi.fn() });
    await expect(
      missing.canActivate({ switchToHttp: () => ({ getRequest: () => ({ headers: {}, ip: '127.0.0.1' }) }) } as never),
    ).rejects.toMatchObject({ code: 'INVALID_ADMIN_ACCESS_TOKEN' });
  });
});

function request() {
  return {
    ip: '127.0.0.1',
    headers: {
      'user-agent': 'iam-controller-test',
      'x-trace-id': 'a'.repeat(32),
      'x-correlation-id': generateUuidV7(),
    },
  };
}

async function authenticatedRequest(adminId = generateUuidV7()) {
  const state: Record<string, unknown> = {
    ...request(),
    headers: { ...request().headers, authorization: 'Bearer test.token' },
  };
  const guard = new IamAdminGuard({
    verify: () => Promise.resolve({ adminId, sessionId: generateUuidV7() }),
  });
  await guard.canActivate({
    switchToHttp: () => ({ getRequest: () => state }),
  } as never);
  return state as never;
}
