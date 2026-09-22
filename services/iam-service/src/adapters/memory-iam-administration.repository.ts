import { redactAuditValue } from '../application/audit.service.js';
import type {
  AdminManagementStatus,
  AuditDecisionInput,
  AuditEventRecord,
  AuditPage,
  AuditQueryInput,
  IamAdministrationRepository,
  PermissionRecord,
  RoleRecord,
} from '../application/iam-administration.repository.js';
import type { AuthorizationSubject } from '../domain/authorization.js';
import { isUuidV7 } from '../domain/uuid-v7.js';
import type { MemoryAdminAccessCoordinator } from './memory-admin-access.coordinator.js';

const ROLE_CURSOR_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/;

interface MemoryAdmin {
  readonly id: string;
  readonly email: string;
  status: AdminManagementStatus;
}

interface MemoryAssignment {
  readonly adminId: string;
  readonly roleId: string;
  readonly assignedBy: string;
}

export interface MemoryIamAdministrationSeed {
  readonly admins?: readonly {
    readonly id: string;
    readonly email: string;
    readonly status: AdminManagementStatus;
  }[];
  readonly permissions?: readonly PermissionRecord[];
}

export class MemoryIamAdministrationRepository implements IamAdministrationRepository {
  private readonly admins = new Map<string, MemoryAdmin>();
  private readonly permissions = new Map<string, PermissionRecord>();
  private readonly roles = new Map<string, RoleRecord>();
  private readonly assignments = new Map<string, MemoryAssignment>();
  private readonly audits: AuditEventRecord[] = [];
  private tail: Promise<void> = Promise.resolve();

  constructor(
    seed: MemoryIamAdministrationSeed = {},
    private readonly coordinator?: MemoryAdminAccessCoordinator,
  ) {
    for (const admin of seed.admins ?? []) this.admins.set(admin.id, { ...admin });
    for (const permission of seed.permissions ?? []) {
      this.permissions.set(permission.key, { ...permission });
    }
    coordinator?.registerManagement({
      check: (adminId) => this.checkDisableAdminState(adminId),
      commit: (adminId) => {
        const admin = this.admins.get(adminId);
        if (!admin) throw stableError('ADMIN_DISABLE_STATE_MISMATCH');
        admin.status = 'DISABLED';
      },
    });
  }

  appendAudit(input: AuditDecisionInput): Promise<void> {
    return this.exclusive(() => {
      this.audits.push(toAuditEvent(input));
    });
  }

  loadAuthorizationSubject(adminId: string): Promise<AuthorizationSubject | null> {
    const admin = this.admins.get(adminId);
    if (!admin || admin.status !== 'ACTIVE') return Promise.resolve(null);
    const assignedRoles = [...this.assignments.values()]
      .filter((assignment) => assignment.adminId === adminId)
      .map((assignment) => this.roles.get(assignment.roleId))
      .filter((role): role is RoleRecord => role !== undefined);
    const grants = assignedRoles.flatMap((role) =>
      role.protected
        ? [...this.permissions.keys()].map((permission) => ({
            permission,
            dataScope: 'ALL' as const,
          }))
        : role.permissionKeys.map((permission) => ({ permission, dataScope: role.dataScope })),
    );
    return Promise.resolve({ adminId, grants });
  }

  listPermissions(): Promise<readonly PermissionRecord[]> {
    return Promise.resolve(
      [...this.permissions.values()]
        .sort((left, right) => left.key.localeCompare(right.key))
        .map((permission) => ({ ...permission })),
    );
  }

  listRoles(input: { readonly cursor?: string; readonly limit: number }) {
    const cursor = input.cursor ? decodeRoleCursor(input.cursor) : null;
    if (input.cursor && !cursor) return Promise.reject(stableError('INVALID_ROLE_QUERY'));
    const selected = [...this.roles.values()]
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .filter(
        (role) =>
          !cursor || role.name > cursor.name || (role.name === cursor.name && role.id > cursor.id),
      );
    const items = selected.slice(0, input.limit).map(cloneRole);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      nextCursor:
        selected.length > input.limit && last ? encodeRoleCursor(last.name, last.id) : null,
    });
  }

  bootstrapSuperAdmin(
    input: Parameters<IamAdministrationRepository['bootstrapSuperAdmin']>[0],
  ): ReturnType<IamAdministrationRepository['bootstrapSuperAdmin']> {
    return this.exclusive(() => {
      const admin = this.admins.get(input.adminId);
      const alreadyBootstrapped = [...this.roles.values()].some((role) => role.protected);
      if (alreadyBootstrapped) {
        this.recordDecision(input.audit, 'DENIED', 'SUPER_ADMIN_ALREADY_BOOTSTRAPPED');
        return { kind: 'already_bootstrapped' as const };
      }
      if (!admin || admin.status !== 'ACTIVE') {
        this.recordDecision(input.audit, 'DENIED', 'ADMIN_NOT_ACTIVE');
        return { kind: 'admin_inactive' as const };
      }
      const role: RoleRecord = {
        id: input.roleId,
        name: 'SUPER_ADMIN',
        description: 'Protected bootstrap super administrator',
        dataScope: 'ALL',
        version: 1,
        protected: true,
        permissionKeys: [],
      };
      this.roles.set(role.id, role);
      this.assignments.set(assignmentKey(admin.id, role.id), {
        adminId: admin.id,
        roleId: role.id,
        assignedBy: admin.id,
      });
      this.recordDecision(input.audit, 'SUCCESS', undefined, null, role);
      return { kind: 'created' as const, role: cloneRole(role) };
    });
  }

  createRole(
    input: Parameters<IamAdministrationRepository['createRole']>[0],
  ): ReturnType<IamAdministrationRepository['createRole']> {
    return this.exclusive(() => {
      const actorId = input.audit.context.actorId;
      if (!this.actorCan(actorId, 'iam:roles:write', 'ALL')) {
        this.recordDecision(input.audit, 'DENIED', 'ADMIN_AUTHORIZATION_DENIED');
        return { kind: 'actor_denied' as const };
      }
      if ([...this.roles.values()].some((role) => role.name === input.role.name)) {
        this.recordDecision(input.audit, 'DENIED', 'ROLE_NAME_CONFLICT');
        return { kind: 'name_conflict' as const };
      }
      if (input.role.permissionKeys.some((key) => !this.permissions.has(key))) {
        this.recordDecision(input.audit, 'DENIED', 'PERMISSION_NOT_FOUND');
        return { kind: 'permission_missing' as const };
      }
      if (!this.actorCanGrant(actorId, input.role.permissionKeys, input.role.dataScope)) {
        this.recordDecision(input.audit, 'DENIED', 'CAPABILITY_CEILING_EXCEEDED');
        return { kind: 'capability_exceeded' as const };
      }
      const role: RoleRecord = { ...input.role, version: 1, protected: false };
      this.roles.set(role.id, role);
      this.recordDecision(input.audit, 'SUCCESS', undefined, null, role);
      return { kind: 'created' as const, role: cloneRole(role) };
    });
  }

  updateRole(
    input: Parameters<IamAdministrationRepository['updateRole']>[0],
  ): ReturnType<IamAdministrationRepository['updateRole']> {
    return this.exclusive(() => {
      const current = this.roles.get(input.roleId);
      const denied = (kind: 'not_found' | 'protected' | 'version_conflict' | 'name_conflict' | 'permission_missing' | 'actor_denied' | 'capability_exceeded', code: string) => {
        this.recordDecision(input.audit, 'DENIED', code, current ?? null, null);
        return { kind } as const;
      };
      if (!current) return denied('not_found', 'ROLE_NOT_FOUND');
      if (current.protected) return denied('protected', 'PROTECTED_ROLE');
      const actorId = input.audit.context.actorId;
      if (!this.actorCan(actorId, 'iam:roles:write', 'ALL', current.id))
        return denied('actor_denied', 'ADMIN_AUTHORIZATION_DENIED');
      if (current.version !== input.expectedVersion)
        return denied('version_conflict', 'ROLE_VERSION_CONFLICT');
      if (
        [...this.roles.values()].some(
          (role) => role.id !== current.id && role.name === input.name,
        )
      )
        return denied('name_conflict', 'ROLE_NAME_CONFLICT');
      if (input.permissionKeys.some((key) => !this.permissions.has(key)))
        return denied('permission_missing', 'PERMISSION_NOT_FOUND');
      if (!this.actorCanGrant(actorId, input.permissionKeys, input.dataScope, current.id))
        return denied('capability_exceeded', 'CAPABILITY_CEILING_EXCEEDED');
      const updated: RoleRecord = {
        ...current,
        name: input.name,
        description: input.description,
        dataScope: input.dataScope,
        version: current.version + 1,
        permissionKeys: [...input.permissionKeys],
      };
      this.roles.set(updated.id, updated);
      this.recordDecision(input.audit, 'SUCCESS', undefined, current, updated);
      return { kind: 'updated' as const, role: cloneRole(updated) };
    });
  }

  deleteRole(
    input: Parameters<IamAdministrationRepository['deleteRole']>[0],
  ): ReturnType<IamAdministrationRepository['deleteRole']> {
    return this.exclusive(() => {
      const role = this.roles.get(input.roleId);
      let result: Awaited<ReturnType<IamAdministrationRepository['deleteRole']>>;
      if (!role) result = 'not_found';
      else if (role.protected) result = 'protected';
      else if (!this.actorCan(input.audit.context.actorId, 'iam:roles:write', 'ALL', role.id))
        result = 'actor_denied';
      else if (role.version !== input.expectedVersion) result = 'version_conflict';
      else if ([...this.assignments.values()].some((item) => item.roleId === role.id))
        result = 'assigned';
      else {
        this.roles.delete(role.id);
        result = 'deleted';
      }
      this.recordDecision(
        input.audit,
        result === 'deleted' ? 'SUCCESS' : 'DENIED',
        result === 'deleted' ? undefined : roleError(result),
        role ?? null,
        null,
      );
      return result;
    });
  }

  assignRole(
    input: Parameters<IamAdministrationRepository['assignRole']>[0],
  ): ReturnType<IamAdministrationRepository['assignRole']> {
    return this.exclusive(() => {
      const admin = this.admins.get(input.adminId), role = this.roles.get(input.roleId);
      let result: Awaited<ReturnType<IamAdministrationRepository['assignRole']>>;
      const actorId = input.audit.context.actorId;
      if (input.assignedBy !== actorId || !this.actorCan(actorId, 'iam:admins:write', 'ALL'))
        result = 'actor_denied';
      else if (!admin || admin.status !== 'ACTIVE') result = 'admin_inactive';
      else if (!role) result = 'role_not_found';
      else if (role.protected && !this.isActiveProtectedAdmin(actorId))
        result = 'protected_role_denied';
      else if (this.assignments.has(assignmentKey(admin.id, role.id))) result = 'already_assigned';
      else if (!this.actorCanGrant(actorId, role.permissionKeys, role.dataScope))
        result = 'capability_exceeded';
      else {
        this.assignments.set(assignmentKey(admin.id, role.id), {
          adminId: admin.id,
          roleId: role.id,
          assignedBy: input.assignedBy,
        });
        result = 'assigned';
      }
      this.recordDecision(
        input.audit,
        result === 'assigned' || result === 'already_assigned' ? 'SUCCESS' : 'DENIED',
        result === 'assigned' || result === 'already_assigned' ? undefined : assignmentError(result),
        null,
        result === 'assigned' ? { adminId: input.adminId, roleId: input.roleId } : null,
      );
      return result;
    });
  }

  revokeRole(
    input: Parameters<IamAdministrationRepository['revokeRole']>[0],
  ): ReturnType<IamAdministrationRepository['revokeRole']> {
    return this.exclusive(() => {
      const key = assignmentKey(input.adminId, input.roleId);
      const assignment = this.assignments.get(key);
      const role = this.roles.get(input.roleId);
      const admin = this.admins.get(input.adminId);
      let result: Awaited<ReturnType<IamAdministrationRepository['revokeRole']>>;
      const actorId = input.audit.context.actorId;
      if (!this.actorCan(actorId, 'iam:admins:write', 'ALL')) result = 'actor_denied';
      else if (!input.expectedAssignment || !assignment) result = 'not_assigned';
      else if (role?.protected && !this.isActiveProtectedAdmin(actorId))
        result = 'protected_role_denied';
      else if (
        admin?.status === 'ACTIVE' &&
        role?.protected &&
        this.activeSuperAdminCount() <= 1
      )
        result = 'last_super_admin';
      else {
        this.assignments.delete(key);
        result = 'revoked';
      }
      this.recordDecision(
        input.audit,
        result === 'revoked' ? 'SUCCESS' : 'DENIED',
        result === 'revoked' ? undefined : assignmentError(result),
        assignment ?? null,
        null,
      );
      return result;
    });
  }

  disableAdmin(
    input: Parameters<IamAdministrationRepository['disableAdmin']>[0],
  ): ReturnType<IamAdministrationRepository['disableAdmin']> {
    if (this.coordinator) {
      const admin = this.admins.get(input.adminId);
      return this.coordinator.disableAdminAccessGuarded(
        input.adminId,
        input.audit.context.occurredAt,
        () => this.actorCan(input.audit.context.actorId, 'iam:admins:write', 'ALL'),
        () => {
          this.recordDecision(
            input.audit,
            'DENIED',
            'ADMIN_AUTHORIZATION_DENIED',
            admin ?? null,
            null,
          );
        },
        (result) => {
          this.recordDecision(
            input.audit,
            result === 'disabled' ? 'SUCCESS' : 'DENIED',
            result === 'disabled' ? undefined : adminError(result),
            admin ? { id: admin.id, status: result === 'disabled' ? 'ACTIVE' : admin.status } : null,
            admin ?? null,
          );
        },
      );
    }
    return Promise.reject(stableError('ADMIN_DISABLE_COORDINATOR_UNAVAILABLE'));
  }

  queryAudit(input: AuditQueryInput): Promise<AuditPage> {
    const cursor = input.cursor ? decodeCursor(input.cursor) : null;
    if (input.cursor && !cursor) return Promise.reject(stableError('INVALID_AUDIT_QUERY'));
    const selected = this.audits
      .filter((event) => !input.actorId || event.actorId === input.actorId)
      .filter((event) => !input.action || event.action === input.action)
      .filter((event) => !input.resourceType || event.resourceType === input.resourceType)
      .filter((event) => !input.resourceId || event.resourceId === input.resourceId)
      .filter((event) => !input.outcome || event.outcome === input.outcome)
      .filter((event) => !input.from || event.occurredAt >= input.from)
      .filter((event) => !input.to || event.occurredAt <= input.to)
      .sort(
        (left, right) =>
          right.occurredAt.getTime() - left.occurredAt.getTime() || right.id.localeCompare(left.id),
      )
      .filter(
        (event) =>
          !cursor ||
          event.occurredAt < cursor.occurredAt ||
          (event.occurredAt.getTime() === cursor.occurredAt.getTime() && event.id < cursor.id),
      );
    const items = selected.slice(0, input.limit).map(cloneAudit);
    const last = items.at(-1);
    return Promise.resolve({
      items,
      nextCursor:
        selected.length > input.limit && last ? encodeCursor(last.occurredAt, last.id) : null,
    });
  }

  private activeSuperAdminCount(): number {
    return [...this.admins.values()].filter(
      (admin) => admin.status === 'ACTIVE' && this.isActiveSuperAdmin(admin.id),
    ).length;
  }

  private disableAdminState(adminId: string): 'disabled' | 'not_found' | 'last_super_admin' {
    const result = this.checkDisableAdminState(adminId);
    if (result !== 'disabled') return result;
    const admin = this.admins.get(adminId);
    if (!admin) return 'not_found';
    admin.status = 'DISABLED';
    return 'disabled';
  }

  private checkDisableAdminState(adminId: string): 'disabled' | 'not_found' | 'last_super_admin' {
    const admin = this.admins.get(adminId);
    if (!admin) return 'not_found';
    if (
      admin.status === 'ACTIVE' &&
      this.isActiveSuperAdmin(admin.id) &&
      this.activeSuperAdminCount() <= 1
    ) {
      return 'last_super_admin';
    }
    return 'disabled';
  }

  private isActiveSuperAdmin(adminId: string): boolean {
    return [...this.assignments.values()].some(
      (assignment) =>
        assignment.adminId === adminId && this.roles.get(assignment.roleId)?.protected === true,
    );
  }

  private isActiveProtectedAdmin(adminId: string | null): boolean {
    return Boolean(
      adminId &&
        this.admins.get(adminId)?.status === 'ACTIVE' &&
        this.isActiveSuperAdmin(adminId),
    );
  }

  private actorCan(
    actorId: string | null,
    permission: string,
    desiredScope: RoleRecord['dataScope'],
    excludeRoleId?: string,
  ): boolean {
    if (!actorId || this.admins.get(actorId)?.status !== 'ACTIVE') return false;
    if (this.isActiveSuperAdmin(actorId)) return true;
    return [...this.assignments.values()].some((assignment) => {
      if (assignment.adminId !== actorId || assignment.roleId === excludeRoleId) return false;
      const role = this.roles.get(assignment.roleId);
      return Boolean(
        role?.permissionKeys.includes(permission) && scopeCovers(role.dataScope, desiredScope),
      );
    });
  }

  private actorCanGrant(
    actorId: string | null,
    permissionKeys: readonly string[],
    desiredScope: RoleRecord['dataScope'],
    excludeRoleId?: string,
  ): boolean {
    return permissionKeys.every((permission) =>
      this.actorCan(actorId, permission, desiredScope, excludeRoleId),
    );
  }

  private recordDecision(
    input: AuditDecisionInput,
    outcome: AuditDecisionInput['outcome'],
    reasonCode?: string,
    before: unknown = input.before,
    after: unknown = input.after,
  ): void {
    this.audits.push(
      toAuditEvent({
        ...input,
        outcome,
        ...(reasonCode ? { reasonCode } : {}),
        before,
        after,
      }),
    );
  }

  private async exclusive<T>(work: () => T | Promise<T>): Promise<T> {
    if (this.coordinator) return this.coordinator.runExclusive(work);
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}

function assignmentKey(adminId: string, roleId: string): string {
  return `${adminId}:${roleId}`;
}

function cloneRole(role: RoleRecord): RoleRecord {
  return { ...role, permissionKeys: [...role.permissionKeys] };
}

function toAuditEvent(input: AuditDecisionInput): AuditEventRecord {
  return {
    id: input.id,
    actorId: input.context.actorId,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    before: redactAuditValue(input.before ?? null),
    after: redactAuditValue(input.after ?? null),
    outcome: input.outcome,
    reasonCode: input.reasonCode ?? null,
    ipAddress: input.context.ipAddress,
    userAgent: input.context.userAgent,
    traceId: input.context.traceId,
    correlationId: input.context.correlationId,
    causationId: input.context.causationId ?? null,
    occurredAt: new Date(input.context.occurredAt),
  };
}

function cloneAudit(event: AuditEventRecord): AuditEventRecord {
  return {
    ...event,
    before: structuredClone(event.before),
    after: structuredClone(event.after),
    occurredAt: new Date(event.occurredAt),
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

function roleError(result: string): string {
  return {
    not_found: 'ROLE_NOT_FOUND',
    protected: 'PROTECTED_ROLE',
    version_conflict: 'ROLE_VERSION_CONFLICT',
    assigned: 'ROLE_ASSIGNED',
    actor_denied: 'ADMIN_AUTHORIZATION_DENIED',
  }[result] ?? 'ROLE_MUTATION_DENIED';
}

function assignmentError(result: string): string {
  return {
    admin_inactive: 'ADMIN_NOT_ACTIVE',
    role_not_found: 'ROLE_NOT_FOUND',
    not_assigned: 'ROLE_NOT_ASSIGNED',
    last_super_admin: 'LAST_SUPER_ADMIN_PROTECTED',
    actor_denied: 'ADMIN_AUTHORIZATION_DENIED',
    protected_role_denied: 'PROTECTED_ROLE_ASSIGNMENT_DENIED',
    capability_exceeded: 'CAPABILITY_CEILING_EXCEEDED',
  }[result] ?? 'ROLE_ASSIGNMENT_DENIED';
}

function adminError(result: string): string {
  return {
    last_super_admin: 'LAST_SUPER_ADMIN_PROTECTED',
    actor_denied: 'ADMIN_AUTHORIZATION_DENIED',
  }[result] ?? 'ADMIN_NOT_FOUND';
}

function scopeCovers(granted: RoleRecord['dataScope'], desired: RoleRecord['dataScope']): boolean {
  return granted === 'ALL' || granted === desired;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
