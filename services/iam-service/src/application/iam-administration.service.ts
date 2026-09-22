import { AuditService, validateManagementContext } from './audit.service.js';
import type {
  AuditDecisionInput,
  AuditOutcome,
  IamAdministrationRepository,
  ManagementRequestContext,
  RoleRecord,
  SuperAdminBootstrapAuthorizer,
} from './iam-administration.repository.js';
import { can, mergeDataScopes, type DataScope } from '../domain/authorization.js';
import { assertUuidV7 } from '../domain/uuid-v7.js';

const ROLE_NAME_PATTERN = /^[a-z][a-z0-9-]{2,63}$/;
const PERMISSION_PATTERN = /^[a-z][a-z0-9_.-]{0,63}(?::[a-z][a-z0-9_.-]{0,63})+$/;
const MAX_ROLE_PERMISSIONS = 100;

export interface IamAdministrationServiceDependencies {
  readonly repository: IamAdministrationRepository;
  readonly bootstrapAuthorizer: SuperAdminBootstrapAuthorizer;
  readonly now?: () => Date;
  readonly uuidV7: () => string;
  readonly metrics?: { increment(name: 'iam_authorization_denials_total'): void };
}

export class IamAdministrationService {
  private readonly audit: AuditService;
  private readonly now: () => Date;

  constructor(private readonly dependencies: IamAdministrationServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date());
    this.audit = new AuditService(dependencies.repository, dependencies.uuidV7);
  }

  async bootstrapSuperAdmin(input: {
    readonly adminId: string;
    readonly proof: string;
    readonly context: Omit<ManagementRequestContext, 'occurredAt'> & { readonly occurredAt?: Date };
  }): Promise<RoleRecord> {
    assertUuidV7(input.adminId, 'INVALID_ADMIN_ID');
    const context = this.context(input.context, true);
    if (
      typeof input.proof !== 'string' ||
      input.proof.length < 16 ||
      input.proof.length > 512 ||
      !(await this.dependencies.bootstrapAuthorizer.authorize(input.proof))
    ) {
      await this.audit.append({
        action: 'super-admin.bootstrap',
        resourceType: 'admin',
        resourceId: input.adminId,
        outcome: 'DENIED',
        reasonCode: 'INVALID_BOOTSTRAP_PROOF',
        context,
      });
      throw stableError('INVALID_BOOTSTRAP_PROOF');
    }
    const result = await this.dependencies.repository.bootstrapSuperAdmin({
      adminId: input.adminId,
      roleId: this.nextUuid('INVALID_ROLE_ID'),
      audit: this.decision('super-admin.bootstrap', 'admin', input.adminId, context, 'SUCCESS'),
    });
    if (result.kind === 'already_bootstrapped') {
      throw stableError('SUPER_ADMIN_ALREADY_BOOTSTRAPPED');
    }
    if (result.kind === 'admin_inactive') throw stableError('ADMIN_NOT_ACTIVE');
    return result.role;
  }

  async listPermissions(contextInput: ManagementRequestContext) {
    const { subject } = await this.authorize(contextInput, 'iam:permissions:read', {});
    void subject;
    return this.dependencies.repository.listPermissions();
  }

  async listRoles(input: {
    readonly context: ManagementRequestContext;
    readonly cursor?: string;
    readonly limit?: number;
  }) {
    const limit = input.limit ?? 50;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (input.cursor !== undefined && !/^[A-Za-z0-9_-]{1,512}$/.test(input.cursor))
    ) {
      throw stableError('INVALID_ROLE_QUERY');
    }
    await this.authorize(input.context, 'iam:roles:read', {});
    return this.dependencies.repository.listRoles({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit,
    });
  }

  async createRole(input: {
    readonly name: string;
    readonly description: string;
    readonly dataScope: DataScope;
    readonly permissionKeys: readonly string[];
    readonly context: ManagementRequestContext;
  }): Promise<RoleRecord> {
    const role = this.validateRole(input);
    const { context } = await this.authorize(input.context, 'iam:roles:write', {});
    const roleId = this.nextUuid('INVALID_ROLE_ID');
    const result = await this.dependencies.repository.createRole({
      role: { id: roleId, ...role },
      audit: this.decision('role.create', 'role', roleId, context, 'SUCCESS'),
    });
    if (result.kind === 'name_conflict') throw stableError('ROLE_NAME_CONFLICT');
    if (result.kind === 'permission_missing') throw stableError('PERMISSION_NOT_FOUND');
    if (result.kind === 'actor_denied') this.authorizationDenied('ADMIN_AUTHORIZATION_DENIED');
    if (result.kind === 'capability_exceeded')
      this.authorizationDenied('CAPABILITY_CEILING_EXCEEDED');
    return result.role;
  }

  async updateRole(input: {
    readonly roleId: string;
    readonly expectedVersion: number;
    readonly name: string;
    readonly description: string;
    readonly dataScope: DataScope;
    readonly permissionKeys: readonly string[];
    readonly context: ManagementRequestContext;
  }): Promise<RoleRecord> {
    assertUuidV7(input.roleId, 'INVALID_ROLE_ID');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw stableError('INVALID_ROLE_VERSION');
    }
    const role = this.validateRole(input);
    const { context } = await this.authorize(input.context, 'iam:roles:write', {});
    const result = await this.dependencies.repository.updateRole({
      roleId: input.roleId,
      expectedVersion: input.expectedVersion,
      ...role,
      audit: this.decision('role.update', 'role', input.roleId, context, 'SUCCESS'),
    });
    if (result.kind !== 'updated') this.throwRoleMutationError(result.kind);
    return result.role;
  }

  async deleteRole(input: {
    readonly roleId: string;
    readonly expectedVersion: number;
    readonly context: ManagementRequestContext;
  }): Promise<void> {
    assertUuidV7(input.roleId, 'INVALID_ROLE_ID');
    if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw stableError('INVALID_ROLE_VERSION');
    }
    const { context } = await this.authorize(input.context, 'iam:roles:write', {});
    const result = await this.dependencies.repository.deleteRole({
      roleId: input.roleId,
      expectedVersion: input.expectedVersion,
      audit: this.decision('role.delete', 'role', input.roleId, context, 'SUCCESS'),
    });
    if (result !== 'deleted') this.throwRoleMutationError(result);
  }

  async assignRole(input: {
    readonly adminId: string;
    readonly roleId: string;
    readonly context: ManagementRequestContext;
  }): Promise<'assigned' | 'already_assigned'> {
    assertUuidV7(input.adminId, 'INVALID_ADMIN_ID');
    assertUuidV7(input.roleId, 'INVALID_ROLE_ID');
    const { context, actorId } = await this.authorize(input.context, 'iam:admins:write', {});
    const result = await this.dependencies.repository.assignRole({
      adminId: input.adminId,
      roleId: input.roleId,
      assignedBy: actorId,
      audit: this.decision('admin-role.assign', 'admin', input.adminId, context, 'SUCCESS'),
    });
    if (result === 'admin_inactive') throw stableError('ADMIN_NOT_ACTIVE');
    if (result === 'role_not_found') throw stableError('ROLE_NOT_FOUND');
    if (result === 'actor_denied') this.authorizationDenied('ADMIN_AUTHORIZATION_DENIED');
    if (result === 'protected_role_denied')
      this.authorizationDenied('PROTECTED_ROLE_ASSIGNMENT_DENIED');
    if (result === 'capability_exceeded') this.authorizationDenied('CAPABILITY_CEILING_EXCEEDED');
    return result;
  }

  async revokeRole(input: {
    readonly adminId: string;
    readonly roleId: string;
    readonly expectedAssignment: boolean;
    readonly context: ManagementRequestContext;
  }): Promise<'revoked'> {
    assertUuidV7(input.adminId, 'INVALID_ADMIN_ID');
    assertUuidV7(input.roleId, 'INVALID_ROLE_ID');
    if (!input.expectedAssignment) throw stableError('ROLE_ASSIGNMENT_PRECONDITION_REQUIRED');
    const { context } = await this.authorize(input.context, 'iam:admins:write', {});
    const result = await this.dependencies.repository.revokeRole({
      adminId: input.adminId,
      roleId: input.roleId,
      expectedAssignment: true,
      audit: this.decision('admin-role.revoke', 'admin', input.adminId, context, 'SUCCESS'),
    });
    if (result === 'last_super_admin') this.authorizationDenied('LAST_SUPER_ADMIN_PROTECTED');
    if (result === 'not_assigned') throw stableError('ROLE_NOT_ASSIGNED');
    if (result === 'actor_denied') this.authorizationDenied('ADMIN_AUTHORIZATION_DENIED');
    if (result === 'protected_role_denied')
      this.authorizationDenied('PROTECTED_ROLE_ASSIGNMENT_DENIED');
    return result;
  }

  async disableAdmin(input: {
    readonly adminId: string;
    readonly context: ManagementRequestContext;
  }): Promise<'disabled'> {
    assertUuidV7(input.adminId, 'INVALID_ADMIN_ID');
    const { context } = await this.authorize(input.context, 'iam:admins:write', {});
    const result = await this.dependencies.repository.disableAdmin({
      adminId: input.adminId,
      audit: this.decision('admin.disable', 'admin', input.adminId, context, 'SUCCESS'),
    });
    if (result === 'last_super_admin') this.authorizationDenied('LAST_SUPER_ADMIN_PROTECTED');
    if (result === 'not_found') throw stableError('ADMIN_NOT_FOUND');
    if (result === 'actor_denied') this.authorizationDenied('ADMIN_AUTHORIZATION_DENIED');
    return result;
  }

  async queryAudit(input: {
    readonly context: ManagementRequestContext;
    readonly actorId?: string;
    readonly action?: string;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly outcome?: AuditOutcome;
    readonly from?: Date;
    readonly to?: Date;
    readonly cursor?: string;
    readonly limit?: number;
  }) {
    const limit = input.limit ?? 50;
    validateAuditQuery(input, limit);
    const { subject, actorId } = await this.authorize(input.context, 'audit:read', {
      ...(input.context.actorId ? { ownerAdminId: input.context.actorId } : {}),
    });
    const scopes = mergeDataScopes(subject.grants, 'audit:read');
    const effectiveActorId = scopes.includes('ALL') ? input.actorId : actorId;
    return this.audit.query({
      ...(effectiveActorId ? { actorId: effectiveActorId } : {}),
      ...(input.action ? { action: input.action } : {}),
      ...(input.resourceType ? { resourceType: input.resourceType } : {}),
      ...(input.resourceId ? { resourceId: input.resourceId } : {}),
      ...(input.outcome ? { outcome: input.outcome } : {}),
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
      limit,
    });
  }

  private async authorize(
    contextInput: ManagementRequestContext,
    permission: string,
    resource: { readonly ownerAdminId?: string; readonly assignedAdminIds?: readonly string[] },
  ) {
    const context = this.context(contextInput, false);
    const actorId = context.actorId;
    if (!actorId) this.authorizationDenied('ADMIN_AUTHORIZATION_DENIED');
    const subject = await this.dependencies.repository.loadAuthorizationSubject(actorId);
    if (!subject || !can(subject, permission, resource)) {
      this.dependencies.metrics?.increment('iam_authorization_denials_total');
      await this.audit.append({
        action: 'authorization.denied',
        resourceType: 'permission',
        resourceId: permission,
        outcome: 'DENIED',
        reasonCode: 'ADMIN_AUTHORIZATION_DENIED',
        context,
      });
      throw stableError('ADMIN_AUTHORIZATION_DENIED');
    }
    return { context, actorId, subject };
  }

  private validateRole(input: {
    readonly name: string;
    readonly description: string;
    readonly dataScope: DataScope;
    readonly permissionKeys: readonly string[];
  }) {
    const name = input.name.trim();
    const description = input.description.trim();
    if (!ROLE_NAME_PATTERN.test(name)) throw stableError('INVALID_ROLE_NAME');
    if (!description || description.length > 512) throw stableError('INVALID_ROLE_DESCRIPTION');
    if (!['ALL', 'OWN', 'ASSIGNED'].includes(input.dataScope)) {
      throw stableError('INVALID_DATA_SCOPE');
    }
    if (
      !isStringArray(input.permissionKeys) ||
      input.permissionKeys.length > MAX_ROLE_PERMISSIONS
    ) {
      throw stableError('INVALID_PERMISSION_KEYS');
    }
    const permissionKeys = [...new Set(input.permissionKeys)].sort();
    if (
      permissionKeys.length !== input.permissionKeys.length ||
      permissionKeys.some((permission) => !PERMISSION_PATTERN.test(permission))
    ) {
      throw stableError('INVALID_PERMISSION_KEYS');
    }
    return { name, description, dataScope: input.dataScope, permissionKeys };
  }

  private context(
    input: Omit<ManagementRequestContext, 'occurredAt'> & { readonly occurredAt?: Date },
    systemAllowed: boolean,
  ): ManagementRequestContext {
    const context = { ...input, occurredAt: input.occurredAt ?? this.now() };
    validateManagementContext(context);
    if (!systemAllowed && context.actorId === null)
      this.authorizationDenied('ADMIN_AUTHORIZATION_DENIED');
    return context;
  }

  private throwRoleMutationError(kind: string): never {
    const code = roleMutationError(kind);
    if (AUTHORIZATION_DENIAL_CODES.has(code)) this.authorizationDenied(code);
    throw stableError(code);
  }

  private authorizationDenied(code: string): never {
    this.dependencies.metrics?.increment('iam_authorization_denials_total');
    throw stableError(code);
  }

  private decision(
    action: string,
    resourceType: string,
    resourceId: string | null,
    context: ManagementRequestContext,
    outcome: AuditOutcome,
  ): AuditDecisionInput {
    return {
      id: this.nextUuid('INVALID_AUDIT_ID'),
      action,
      resourceType,
      resourceId,
      outcome,
      context,
    };
  }

  private nextUuid(code: string): string {
    const id = this.dependencies.uuidV7();
    assertUuidV7(id, code);
    return id;
  }
}

const AUTHORIZATION_DENIAL_CODES = new Set([
  'ADMIN_AUTHORIZATION_DENIED',
  'CAPABILITY_CEILING_EXCEEDED',
  'LAST_SUPER_ADMIN_PROTECTED',
  'PROTECTED_ROLE',
  'PROTECTED_ROLE_ASSIGNMENT_DENIED',
  'ROLE_ASSIGNMENT_DENIED',
  'ROLE_MUTATION_DENIED',
]);

function validateAuditQuery(
  input: {
    readonly actorId?: string;
    readonly action?: string;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly outcome?: AuditOutcome;
    readonly from?: Date;
    readonly to?: Date;
    readonly cursor?: string;
  },
  limit: number,
): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw stableError('INVALID_AUDIT_QUERY');
  }
  if (input.actorId) assertUuidV7(input.actorId, 'INVALID_AUDIT_QUERY');
  if (input.action && !validFilter(input.action, 128)) throw stableError('INVALID_AUDIT_QUERY');
  if (input.resourceType && !validFilter(input.resourceType, 64))
    throw stableError('INVALID_AUDIT_QUERY');
  if (input.resourceId && !validFilter(input.resourceId, 128))
    throw stableError('INVALID_AUDIT_QUERY');
  const outcome: unknown = input.outcome;
  if (typeof outcome === 'string' && outcome !== 'SUCCESS' && outcome !== 'DENIED')
    throw stableError('INVALID_AUDIT_QUERY');
  if (input.from && !validDate(input.from)) throw stableError('INVALID_AUDIT_QUERY');
  if (input.to && !validDate(input.to)) throw stableError('INVALID_AUDIT_QUERY');
  if (input.from && input.to && input.from > input.to) throw stableError('INVALID_AUDIT_QUERY');
  if (input.cursor && !/^[A-Za-z0-9_-]{1,512}$/.test(input.cursor))
    throw stableError('INVALID_AUDIT_QUERY');
}

function validDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validFilter(value: string, max: number): boolean {
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    (value as readonly unknown[]).every((entry) => typeof entry === 'string')
  );
}

function roleMutationError(kind: string): string {
  return (
    {
      not_found: 'ROLE_NOT_FOUND',
      protected: 'PROTECTED_ROLE',
      version_conflict: 'ROLE_VERSION_CONFLICT',
      name_conflict: 'ROLE_NAME_CONFLICT',
      permission_missing: 'PERMISSION_NOT_FOUND',
      actor_denied: 'ADMIN_AUTHORIZATION_DENIED',
      capability_exceeded: 'CAPABILITY_CEILING_EXCEEDED',
      assigned: 'ROLE_ASSIGNED',
    }[kind] ?? 'ROLE_MUTATION_DENIED'
  );
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
