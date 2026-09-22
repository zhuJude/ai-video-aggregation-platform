import { redactAuditValue } from '../application/audit.service.js';
import type {
  AuditDecisionInput,
  AuditEventRecord,
  AuditPage,
  AuditQueryInput,
  IamAdministrationRepository,
  PermissionRecord,
  RoleRecord,
} from '../application/iam-administration.repository.js';
import type { AuthorizationSubject, DataScope } from '../domain/authorization.js';
import { isUuidV7 } from '../domain/uuid-v7.js';
import {
  Prisma,
  type AuditEvent,
  type PrismaClient,
  type Role,
} from '../generated/prisma/client.js';

const TRANSACTION_OPTIONS = Object.freeze({
  isolationLevel: 'ReadCommitted' as const,
  maxWait: 5_000,
  timeout: 10_000,
});
const ROLE_CURSOR_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/;

type TransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
type Client = PrismaClient | TransactionClient;

export class PrismaIamAdministrationRepository implements IamAdministrationRepository {
  constructor(private readonly prisma: Client) {}

  appendAudit(input: AuditDecisionInput): Promise<void> {
    return this.inTransaction(async (transaction) => {
      await appendAudit(transaction, input);
    });
  }

  async loadAuthorizationSubject(adminId: string): Promise<AuthorizationSubject | null> {
    const admin = await this.prisma.adminUser.findFirst({
      where: { id: adminId, status: 'ACTIVE' },
      include: {
        roles: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    });
    if (!admin) return null;
    if (admin.roles.some(({ role }) => role.protected)) {
      const permissions = await this.prisma.permission.findMany({ select: { key: true } });
      return {
        adminId,
        grants: permissions.map(({ key }) => ({ permission: key, dataScope: 'ALL' })),
      };
    }
    return {
      adminId,
      grants: admin.roles.flatMap(({ role }) =>
        role.permissions.map(({ permission }) => ({
          permission: permission.key,
          dataScope: role.dataScope as DataScope,
        })),
      ),
    };
  }

  async listPermissions(): Promise<readonly PermissionRecord[]> {
    return this.prisma.permission.findMany({
      select: { id: true, key: true, description: true },
      orderBy: { key: 'asc' },
    });
  }

  async listRoles(input: { readonly cursor?: string; readonly limit: number }) {
    const cursor = input.cursor ? decodeRoleCursor(input.cursor) : null;
    if (input.cursor && !cursor) throw stableError('INVALID_ROLE_QUERY');
    const rows = await this.prisma.role.findMany({
      ...(cursor
        ? {
            where: {
              OR: [{ name: { gt: cursor.name } }, { name: cursor.name, id: { gt: cursor.id } }],
            },
          }
        : {}),
      include: { permissions: { include: { permission: true } } },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
      take: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map((role) =>
      mapRole(
        role,
        role.permissions.map(({ permission }) => permission.key),
      ),
    );
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeRoleCursor(last.name, last.id) : null,
    };
  }

  bootstrapSuperAdmin(
    input: Parameters<IamAdministrationRepository['bootstrapSuperAdmin']>[0],
  ): ReturnType<IamAdministrationRepository['bootstrapSuperAdmin']> {
    return this.inTransaction(async (transaction) => {
      await acquireLocks(transaction, [
        'iam:authorization-graph',
        'iam:super-admin',
        `iam:admin:${input.adminId}`,
      ]);
      const admin = await lockAdmin(transaction, input.adminId);
      const existing = await transaction.role.findFirst({ where: { protected: true } });
      if (existing) {
        await appendDecision(
          transaction,
          input.audit,
          'DENIED',
          'SUPER_ADMIN_ALREADY_BOOTSTRAPPED',
        );
        return { kind: 'already_bootstrapped' as const };
      }
      if (!admin || admin.status !== 'ACTIVE') {
        await appendDecision(transaction, input.audit, 'DENIED', 'ADMIN_NOT_ACTIVE');
        return { kind: 'admin_inactive' as const };
      }
      const role = await transaction.role.create({
        data: {
          id: input.roleId,
          name: 'SUPER_ADMIN',
          description: 'Protected bootstrap super administrator',
          dataScope: 'ALL',
          protected: true,
        },
      });
      await transaction.adminRole.create({
        data: { adminId: admin.id, roleId: role.id, assignedBy: admin.id },
      });
      const mapped = mapRole(role, []);
      await appendDecision(transaction, input.audit, 'SUCCESS', undefined, null, mapped);
      return { kind: 'created' as const, role: mapped };
    });
  }

  createRole(
    input: Parameters<IamAdministrationRepository['createRole']>[0],
  ): ReturnType<IamAdministrationRepository['createRole']> {
    return this.inTransaction(async (transaction) => {
      const actorId = input.audit.context.actorId;
      await acquireLocks(transaction, [
        'iam:authorization-graph',
        `iam:admin:${actorId ?? 'anonymous'}`,
        `iam:role-name:${input.role.name}`,
      ]);
      const actor = await loadActorCapability(transaction, actorId);
      if (!actorCan(actor, 'iam:roles:write', 'ALL')) {
        await appendDecision(transaction, input.audit, 'DENIED', 'ADMIN_AUTHORIZATION_DENIED');
        return { kind: 'actor_denied' as const };
      }
      if (await transaction.role.findUnique({ where: { name: input.role.name } })) {
        await appendDecision(transaction, input.audit, 'DENIED', 'ROLE_NAME_CONFLICT');
        return { kind: 'name_conflict' as const };
      }
      const permissions = await loadPermissions(transaction, input.role.permissionKeys);
      if (permissions.length !== input.role.permissionKeys.length) {
        await appendDecision(transaction, input.audit, 'DENIED', 'PERMISSION_NOT_FOUND');
        return { kind: 'permission_missing' as const };
      }
      if (!actorCanGrant(actor, input.role.permissionKeys, input.role.dataScope)) {
        await appendDecision(transaction, input.audit, 'DENIED', 'CAPABILITY_CEILING_EXCEEDED');
        return { kind: 'capability_exceeded' as const };
      }
      const created = await transaction.role.create({
        data: {
          id: input.role.id,
          name: input.role.name,
          description: input.role.description,
          dataScope: input.role.dataScope,
        },
      });
      if (permissions.length > 0) {
        await transaction.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: created.id,
            permissionId: permission.id,
          })),
        });
      }
      const mapped = mapRole(created, input.role.permissionKeys);
      await appendDecision(transaction, input.audit, 'SUCCESS', undefined, null, mapped);
      return { kind: 'created' as const, role: mapped };
    });
  }

  updateRole(
    input: Parameters<IamAdministrationRepository['updateRole']>[0],
  ): ReturnType<IamAdministrationRepository['updateRole']> {
    return this.inTransaction(async (transaction) => {
      await acquireLocks(transaction, [
        'iam:authorization-graph',
        `iam:admin:${input.audit.context.actorId ?? 'anonymous'}`,
        `iam:role:${input.roleId}`,
        `iam:role-name:${input.name}`,
      ]);
      await lockRole(transaction, input.roleId);
      const current = await loadRole(transaction, input.roleId);
      if (!current) return deniedRole(transaction, input.audit, 'not_found', 'ROLE_NOT_FOUND');
      if (current.protected)
        return deniedRole(transaction, input.audit, 'protected', 'PROTECTED_ROLE', current);
      const actor = await loadActorCapability(
        transaction,
        input.audit.context.actorId,
        input.roleId,
      );
      if (!actorCan(actor, 'iam:roles:write', 'ALL'))
        return deniedRole(
          transaction,
          input.audit,
          'actor_denied',
          'ADMIN_AUTHORIZATION_DENIED',
          current,
        );
      if (current.version !== input.expectedVersion)
        return deniedRole(
          transaction,
          input.audit,
          'version_conflict',
          'ROLE_VERSION_CONFLICT',
          current,
        );
      const conflicting = await transaction.role.findFirst({
        where: { name: input.name, id: { not: input.roleId } },
        select: { id: true },
      });
      if (conflicting)
        return deniedRole(transaction, input.audit, 'name_conflict', 'ROLE_NAME_CONFLICT', current);
      const permissions = await loadPermissions(transaction, input.permissionKeys);
      if (permissions.length !== input.permissionKeys.length)
        return deniedRole(
          transaction,
          input.audit,
          'permission_missing',
          'PERMISSION_NOT_FOUND',
          current,
        );
      if (!actorCanGrant(actor, input.permissionKeys, input.dataScope))
        return deniedRole(
          transaction,
          input.audit,
          'capability_exceeded',
          'CAPABILITY_CEILING_EXCEEDED',
          current,
        );
      const updated = await transaction.role.updateMany({
        where: { id: input.roleId, version: input.expectedVersion, protected: false },
        data: {
          name: input.name,
          description: input.description,
          dataScope: input.dataScope,
          version: { increment: 1 },
        },
      });
      if (updated.count !== 1)
        return deniedRole(
          transaction,
          input.audit,
          'version_conflict',
          'ROLE_VERSION_CONFLICT',
          current,
        );
      await transaction.rolePermission.deleteMany({ where: { roleId: input.roleId } });
      if (permissions.length > 0) {
        await transaction.rolePermission.createMany({
          data: permissions.map((permission) => ({
            roleId: input.roleId,
            permissionId: permission.id,
          })),
        });
      }
      const persisted = await loadRole(transaction, input.roleId);
      if (!persisted) throw stableError('ROLE_PERSISTENCE_FAILED');
      await appendDecision(transaction, input.audit, 'SUCCESS', undefined, current, persisted);
      return { kind: 'updated' as const, role: persisted };
    });
  }

  deleteRole(
    input: Parameters<IamAdministrationRepository['deleteRole']>[0],
  ): ReturnType<IamAdministrationRepository['deleteRole']> {
    return this.inTransaction(async (transaction) => {
      await acquireLocks(transaction, [
        'iam:authorization-graph',
        `iam:admin:${input.audit.context.actorId ?? 'anonymous'}`,
        `iam:role:${input.roleId}`,
      ]);
      await lockRole(transaction, input.roleId);
      const role = await loadRole(transaction, input.roleId);
      let result: Awaited<ReturnType<IamAdministrationRepository['deleteRole']>>;
      if (!role) result = 'not_found';
      else if (role.protected) result = 'protected';
      else if (
        !actorCan(
          await loadActorCapability(transaction, input.audit.context.actorId, role.id),
          'iam:roles:write',
          'ALL',
        )
      )
        result = 'actor_denied';
      else if (role.version !== input.expectedVersion) result = 'version_conflict';
      else if ((await transaction.adminRole.count({ where: { roleId: role.id } })) > 0)
        result = 'assigned';
      else {
        await transaction.rolePermission.deleteMany({ where: { roleId: role.id } });
        const deleted = await transaction.role.deleteMany({
          where: { id: role.id, version: input.expectedVersion, protected: false },
        });
        result = deleted.count === 1 ? 'deleted' : 'version_conflict';
      }
      await appendDecision(
        transaction,
        input.audit,
        result === 'deleted' ? 'SUCCESS' : 'DENIED',
        result === 'deleted' ? undefined : roleResultCode(result),
        role,
        null,
      );
      return result;
    });
  }

  assignRole(
    input: Parameters<IamAdministrationRepository['assignRole']>[0],
  ): ReturnType<IamAdministrationRepository['assignRole']> {
    return this.inTransaction(async (transaction) => {
      await acquireLocks(transaction, [
        'iam:authorization-graph',
        'iam:super-admin',
        `iam:admin:${input.audit.context.actorId ?? 'anonymous'}`,
        `iam:admin:${input.adminId}`,
        `iam:role:${input.roleId}`,
      ]);
      const admin = await lockAdmin(transaction, input.adminId);
      const actor = await loadActorCapability(transaction, input.audit.context.actorId);
      await lockRole(transaction, input.roleId);
      const role = await loadRole(transaction, input.roleId);
      let result: Awaited<ReturnType<IamAdministrationRepository['assignRole']>>;
      if (
        input.assignedBy !== input.audit.context.actorId ||
        !actorCan(actor, 'iam:admins:write', 'ALL')
      )
        result = 'actor_denied';
      else if (!admin || admin.status !== 'ACTIVE') result = 'admin_inactive';
      else if (!role) result = 'role_not_found';
      else if (role.protected && !actor?.protected) result = 'protected_role_denied';
      else if (
        await transaction.adminRole.findUnique({
          where: { adminId_roleId: { adminId: input.adminId, roleId: input.roleId } },
        })
      )
        result = 'already_assigned';
      else if (!actorCanGrant(actor, role.permissionKeys, role.dataScope))
        result = 'capability_exceeded';
      else {
        await transaction.adminRole.create({
          data: {
            adminId: input.adminId,
            roleId: input.roleId,
            assignedBy: input.assignedBy,
          },
        });
        result = 'assigned';
      }
      await appendDecision(
        transaction,
        input.audit,
        result === 'assigned' || result === 'already_assigned' ? 'SUCCESS' : 'DENIED',
        result === 'assigned' || result === 'already_assigned'
          ? undefined
          : assignmentResultCode(result),
        null,
        result === 'assigned' ? { adminId: input.adminId, roleId: input.roleId } : null,
      );
      return result;
    });
  }

  revokeRole(
    input: Parameters<IamAdministrationRepository['revokeRole']>[0],
  ): ReturnType<IamAdministrationRepository['revokeRole']> {
    return this.inTransaction(async (transaction) => {
      await acquireLocks(transaction, [
        'iam:authorization-graph',
        'iam:super-admin',
        `iam:admin:${input.audit.context.actorId ?? 'anonymous'}`,
        `iam:admin:${input.adminId}`,
        `iam:role:${input.roleId}`,
      ]);
      const admin = await lockAdmin(transaction, input.adminId);
      const actor = await loadActorCapability(transaction, input.audit.context.actorId);
      await lockRole(transaction, input.roleId);
      const role = await transaction.role.findUnique({ where: { id: input.roleId } });
      const assignment = await transaction.adminRole.findUnique({
        where: { adminId_roleId: { adminId: input.adminId, roleId: input.roleId } },
      });
      let result: Awaited<ReturnType<IamAdministrationRepository['revokeRole']>>;
      if (!actorCan(actor, 'iam:admins:write', 'ALL')) result = 'actor_denied';
      else if (!input.expectedAssignment || !assignment) result = 'not_assigned';
      else if (role?.protected && !actor?.protected) result = 'protected_role_denied';
      else if (
        admin?.status === 'ACTIVE' &&
        role?.protected &&
        (await activeSuperAdminCount(transaction)) <= 1
      )
        result = 'last_super_admin';
      else {
        const removed = await transaction.adminRole.deleteMany({
          where: { adminId: input.adminId, roleId: input.roleId },
        });
        result = removed.count === 1 ? 'revoked' : 'not_assigned';
      }
      await appendDecision(
        transaction,
        input.audit,
        result === 'revoked' ? 'SUCCESS' : 'DENIED',
        result === 'revoked' ? undefined : assignmentResultCode(result),
        assignment,
        null,
      );
      return result;
    });
  }

  disableAdmin(
    input: Parameters<IamAdministrationRepository['disableAdmin']>[0],
  ): ReturnType<IamAdministrationRepository['disableAdmin']> {
    return this.inTransaction(async (transaction) => {
      await acquireLocks(transaction, [
        'iam:authorization-graph',
        'iam:super-admin',
        `iam:admin:${input.audit.context.actorId ?? 'anonymous'}`,
        `iam:admin:${input.adminId}`,
      ]);
      const admin = await lockAdmin(transaction, input.adminId);
      const actor = await loadActorCapability(transaction, input.audit.context.actorId);
      if (!actorCan(actor, 'iam:admins:write', 'ALL')) {
        await appendDecision(transaction, input.audit, 'DENIED', 'ADMIN_AUTHORIZATION_DENIED');
        return 'actor_denied' as const;
      }
      if (!admin) {
        await appendDecision(transaction, input.audit, 'DENIED', 'ADMIN_NOT_FOUND');
        return 'not_found' as const;
      }
      const protectedAssignment = await transaction.adminRole.findFirst({
        where: { adminId: admin.id, role: { protected: true } },
        select: { adminId: true },
      });
      if (
        admin.status === 'ACTIVE' &&
        protectedAssignment &&
        (await activeSuperAdminCount(transaction)) <= 1
      ) {
        await appendDecision(
          transaction,
          input.audit,
          'DENIED',
          'LAST_SUPER_ADMIN_PROTECTED',
          { id: admin.id, status: admin.status },
          null,
        );
        return 'last_super_admin' as const;
      }
      const databaseTime = await databaseClock(transaction);
      const changed = await transaction.adminUser.updateMany({
        where: { id: admin.id, status: 'ACTIVE' },
        data: { status: 'DISABLED' },
      });
      const pending = await transaction.adminSession.findMany({
        where: { adminId: admin.id, status: 'PENDING' },
        select: { id: true },
      });
      const pendingIds = pending.map(({ id }) => id);
      if (pendingIds.length > 0) {
        await transaction.mfaChallenge.updateMany({
          where: { adminId: admin.id, reservedSessionId: { in: pendingIds }, consumedAt: null },
          data: { reservedSessionId: null, reservedUntil: null },
        });
        await transaction.mfaRecoveryCode.updateMany({
          where: { adminId: admin.id, reservedSessionId: { in: pendingIds }, consumedAt: null },
          data: { reservedSessionId: null, reservedUntil: null },
        });
        await transaction.adminSession.updateMany({
          where: { adminId: admin.id, id: { in: pendingIds }, status: 'PENDING' },
          data: {
            status: 'CANCELLED',
            revokedAt: databaseTime,
            pendingKind: null,
            pendingChallengeId: null,
            pendingRecoveryCodeId: null,
            pendingTotpTimeStep: null,
            pendingPredecessorId: null,
            pendingExpiresAt: null,
          },
        });
      }
      await transaction.adminSession.updateMany({
        where: { adminId: admin.id, status: 'ACTIVE', revokedAt: null },
        data: { revokedAt: databaseTime },
      });
      await appendDecision(
        transaction,
        input.audit,
        'SUCCESS',
        undefined,
        { id: admin.id, status: admin.status },
        { id: admin.id, status: changed.count === 1 ? 'DISABLED' : admin.status },
      );
      return 'disabled' as const;
    });
  }

  async queryAudit(input: AuditQueryInput): Promise<AuditPage> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (input.cursor && !cursor) throw stableError('INVALID_AUDIT_QUERY');
    const where: Prisma.AuditEventWhereInput = {
      ...(input.actorId ? { actorId: input.actorId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.from || input.to
        ? {
            occurredAt: {
              ...(input.from ? { gte: input.from } : {}),
              ...(input.to ? { lte: input.to } : {}),
            },
          }
        : {}),
      ...(cursor
        ? {
            OR: [
              { occurredAt: { lt: cursor.occurredAt } },
              { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    };
    const rows = await this.prisma.auditEvent.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: input.limit + 1,
    });
    const hasMore = rows.length > input.limit;
    const items = rows.slice(0, input.limit).map(mapAudit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.occurredAt, last.id) : null,
    };
  }

  private inTransaction<T>(work: (transaction: TransactionClient) => Promise<T>): Promise<T> {
    if ('$transaction' in this.prisma && typeof this.prisma.$transaction === 'function') {
      return this.prisma.$transaction(work, TRANSACTION_OPTIONS);
    }
    return work(this.prisma);
  }
}

async function loadPermissions(transaction: TransactionClient, keys: readonly string[]) {
  if (keys.length === 0) return [];
  return transaction.permission.findMany({
    where: { key: { in: [...keys] } },
    select: { id: true, key: true },
    orderBy: { key: 'asc' },
  });
}

interface ActorCapability {
  readonly protected: boolean;
  readonly grants: readonly {
    readonly permission: string;
    readonly dataScope: DataScope;
  }[];
}

async function loadActorCapability(
  transaction: TransactionClient,
  actorId: string | null,
  excludedRoleId?: string,
): Promise<ActorCapability | null> {
  if (!actorId) return null;
  const actor = await transaction.adminUser.findFirst({
    where: { id: actorId, status: 'ACTIVE' },
    include: {
      roles: {
        include: {
          role: { include: { permissions: { include: { permission: true } } } },
        },
      },
    },
  });
  if (!actor) return null;
  return {
    protected: actor.roles.some(({ role }) => role.protected),
    grants: actor.roles
      .filter(({ role }) => role.id !== excludedRoleId)
      .flatMap(({ role }) =>
        role.permissions.flatMap(({ permission }) =>
          isDataScope(role.dataScope)
            ? [{ permission: permission.key, dataScope: role.dataScope }]
            : [],
        ),
      ),
  };
}

function actorCan(
  actor: ActorCapability | null,
  permission: string,
  desiredScope: DataScope,
): boolean {
  return Boolean(
    actor &&
    (actor.protected ||
      actor.grants.some(
        (grant) => grant.permission === permission && scopeCovers(grant.dataScope, desiredScope),
      )),
  );
}

function actorCanGrant(
  actor: ActorCapability | null,
  permissions: readonly string[],
  desiredScope: DataScope,
): boolean {
  return permissions.every((permission) => actorCan(actor, permission, desiredScope));
}

function scopeCovers(held: DataScope, desired: DataScope): boolean {
  return held === 'ALL' || held === desired;
}

function isDataScope(value: string): value is DataScope {
  return value === 'ALL' || value === 'OWN' || value === 'ASSIGNED';
}

async function loadRole(
  transaction: TransactionClient,
  roleId: string,
): Promise<RoleRecord | null> {
  const role = await transaction.role.findUnique({
    where: { id: roleId },
    include: { permissions: { include: { permission: true } } },
  });
  return role
    ? mapRole(
        role,
        role.permissions.map(({ permission }) => permission.key),
      )
    : null;
}

function mapRole(role: Role, permissionKeys: readonly string[]): RoleRecord {
  return {
    id: role.id,
    name: role.name,
    description: role.description,
    dataScope: role.dataScope as DataScope,
    version: role.version,
    protected: role.protected,
    permissionKeys: [...permissionKeys].sort(),
  };
}

async function deniedRole(
  transaction: TransactionClient,
  audit: AuditDecisionInput,
  kind:
    | 'not_found'
    | 'protected'
    | 'version_conflict'
    | 'name_conflict'
    | 'permission_missing'
    | 'actor_denied'
    | 'capability_exceeded',
  reasonCode: string,
  before: unknown = null,
) {
  await appendDecision(transaction, audit, 'DENIED', reasonCode, before, null);
  return { kind } as const;
}

async function appendDecision(
  transaction: TransactionClient,
  input: AuditDecisionInput,
  outcome: 'SUCCESS' | 'DENIED',
  reasonCode?: string,
  before: unknown = input.before,
  after: unknown = input.after,
): Promise<void> {
  await appendAudit(transaction, {
    ...input,
    outcome,
    ...(reasonCode ? { reasonCode } : {}),
    before,
    after,
  });
}

async function appendAudit(
  transaction: TransactionClient,
  input: AuditDecisionInput,
): Promise<void> {
  await transaction.auditEvent.create({
    data: {
      id: input.id,
      actorId: input.context.actorId,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      before: jsonValue(redactAuditValue(input.before ?? null)),
      after: jsonValue(redactAuditValue(input.after ?? null)),
      outcome: input.outcome,
      reasonCode: input.reasonCode ?? null,
      ipAddress: input.context.ipAddress,
      userAgent: input.context.userAgent,
      traceId: input.context.traceId,
      correlationId: input.context.correlationId,
      causationId: input.context.causationId ?? null,
      occurredAt: input.context.occurredAt,
    },
  });
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

async function activeSuperAdminCount(transaction: TransactionClient): Promise<number> {
  const rows = await transaction.$queryRaw<{ count: number }[]>(Prisma.sql`
    SELECT count(DISTINCT ar."admin_id")::integer AS "count"
    FROM "admin_roles" ar
    JOIN "roles" r ON r."id" = ar."role_id" AND r."protected" = true
    JOIN "admin_users" a ON a."id" = ar."admin_id" AND a."status" = 'ACTIVE'
  `);
  return rows[0]?.count ?? 0;
}

async function lockAdmin(transaction: TransactionClient, adminId: string) {
  const rows = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id"::text AS "id"
    FROM "admin_users"
    WHERE "id" = CAST(${adminId} AS uuid)
    FOR UPDATE
  `);
  if (rows.length !== 1) return null;
  return transaction.adminUser.findUnique({ where: { id: adminId } });
}

async function lockRole(transaction: TransactionClient, roleId: string): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"::text AS "id"
    FROM "roles"
    WHERE "id" = CAST(${roleId} AS uuid)
    FOR UPDATE
  `);
}

async function databaseClock(transaction: TransactionClient): Promise<Date> {
  const rows = await transaction.$queryRaw<{ now: Date }[]>(Prisma.sql`
    SELECT clock_timestamp() AS "now"
  `);
  const now = rows[0]?.now;
  if (!now) throw stableError('DATABASE_CLOCK_UNAVAILABLE');
  return now;
}

async function acquireLocks(
  transaction: TransactionClient,
  keys: readonly string[],
): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await transaction.$queryRaw(
      Prisma.sql`
        SELECT 1::integer AS "acquired"
        FROM (
          SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))
        ) AS "held_lock"
      `,
    );
  }
}

function mapAudit(event: AuditEvent): AuditEventRecord {
  return {
    id: event.id,
    actorId: event.actorId,
    action: event.action,
    resourceType: event.resourceType,
    resourceId: event.resourceId,
    before: event.before,
    after: event.after,
    outcome: event.outcome as 'SUCCESS' | 'DENIED',
    reasonCode: event.reasonCode,
    ipAddress: event.ipAddress,
    userAgent: event.userAgent,
    traceId: event.traceId,
    correlationId: event.correlationId,
    causationId: event.causationId,
    occurredAt: event.occurredAt,
  };
}

function encodeCursor(occurredAt: Date, id: string): string {
  return Buffer.from(`${occurredAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

function decodeCursor(value: string): { readonly occurredAt: Date; readonly id: string } | null {
  try {
    const [timestamp, id, extra] = Buffer.from(value, 'base64url').toString('utf8').split('|');
    const occurredAt = new Date(timestamp ?? '');
    return !extra && id && isUuidV7(id) && Number.isFinite(occurredAt.getTime())
      ? { occurredAt, id }
      : null;
  } catch {
    return null;
  }
}

function encodeRoleCursor(name: string, id: string): string {
  return Buffer.from(`${name}|${id}`, 'utf8').toString('base64url');
}

function decodeRoleCursor(value: string): { readonly name: string; readonly id: string } | null {
  try {
    const [name, id, extra] = Buffer.from(value, 'base64url').toString('utf8').split('|');
    return !extra && name && ROLE_CURSOR_NAME.test(name) && id && isUuidV7(id)
      ? { name, id }
      : null;
  } catch {
    return null;
  }
}

function roleResultCode(result: string): string {
  return (
    {
      not_found: 'ROLE_NOT_FOUND',
      protected: 'PROTECTED_ROLE',
      version_conflict: 'ROLE_VERSION_CONFLICT',
      assigned: 'ROLE_ASSIGNED',
      actor_denied: 'ADMIN_AUTHORIZATION_DENIED',
    }[result] ?? 'ROLE_MUTATION_DENIED'
  );
}

function assignmentResultCode(result: string): string {
  return (
    {
      admin_inactive: 'ADMIN_NOT_ACTIVE',
      role_not_found: 'ROLE_NOT_FOUND',
      not_assigned: 'ROLE_NOT_ASSIGNED',
      last_super_admin: 'LAST_SUPER_ADMIN_PROTECTED',
      actor_denied: 'ADMIN_AUTHORIZATION_DENIED',
      protected_role_denied: 'PROTECTED_ROLE_ASSIGNMENT_DENIED',
      capability_exceeded: 'CAPABILITY_CEILING_EXCEEDED',
    }[result] ?? 'ROLE_ASSIGNMENT_DENIED'
  );
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
