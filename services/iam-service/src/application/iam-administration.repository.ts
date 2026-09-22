import type { AuthorizationSubject, DataScope } from '../domain/authorization.js';

export type AdminManagementStatus = 'ACTIVE' | 'DISABLED';
export type AuditOutcome = 'SUCCESS' | 'DENIED';

export interface ManagementRequestContext {
  readonly actorId: string | null;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly occurredAt: Date;
}

export interface PermissionRecord {
  readonly id: string;
  readonly key: string;
  readonly description: string;
}

export interface RoleRecord {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly dataScope: DataScope;
  readonly version: number;
  readonly protected: boolean;
  readonly permissionKeys: readonly string[];
}

export interface AuditEventRecord {
  readonly id: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly outcome: AuditOutcome;
  readonly reasonCode: string | null;
  readonly ipAddress: string;
  readonly userAgent: string;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId: string | null;
  readonly occurredAt: Date;
}

export interface AuditDecisionInput {
  readonly id: string;
  readonly action: string;
  readonly resourceType: string;
  readonly resourceId: string | null;
  readonly before?: unknown;
  readonly after?: unknown;
  readonly outcome: AuditOutcome;
  readonly reasonCode?: string;
  readonly context: ManagementRequestContext;
}

export interface AuditQueryInput {
  readonly actorId?: string;
  readonly action?: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly outcome?: AuditOutcome;
  readonly from?: Date;
  readonly to?: Date;
  readonly cursor?: string;
  readonly limit: number;
}

export interface AuditPage {
  readonly items: readonly AuditEventRecord[];
  readonly nextCursor: string | null;
}

export interface RolePage {
  readonly items: readonly RoleRecord[];
  readonly nextCursor: string | null;
}

export interface IamAdministrationRepository {
  appendAudit(input: AuditDecisionInput): Promise<void>;
  loadAuthorizationSubject(adminId: string): Promise<AuthorizationSubject | null>;
  listPermissions(): Promise<readonly PermissionRecord[]>;
  listRoles(input: { readonly cursor?: string; readonly limit: number }): Promise<RolePage>;
  bootstrapSuperAdmin(input: {
    readonly adminId: string;
    readonly roleId: string;
    readonly audit: AuditDecisionInput;
  }): Promise<
    | { readonly kind: 'created'; readonly role: RoleRecord }
    | { readonly kind: 'already_bootstrapped' }
    | { readonly kind: 'admin_inactive' }
  >;
  createRole(input: {
    readonly role: Omit<RoleRecord, 'version' | 'protected'>;
    readonly audit: AuditDecisionInput;
  }): Promise<
    | { readonly kind: 'created'; readonly role: RoleRecord }
    | { readonly kind: 'name_conflict' }
    | { readonly kind: 'permission_missing' }
    | { readonly kind: 'actor_denied' }
    | { readonly kind: 'capability_exceeded' }
  >;
  updateRole(input: {
    readonly roleId: string;
    readonly expectedVersion: number;
    readonly name: string;
    readonly description: string;
    readonly dataScope: DataScope;
    readonly permissionKeys: readonly string[];
    readonly audit: AuditDecisionInput;
  }): Promise<{ readonly kind: 'updated'; readonly role: RoleRecord } | { readonly kind: 'not_found' | 'protected' | 'version_conflict' | 'name_conflict' | 'permission_missing' | 'actor_denied' | 'capability_exceeded' }>;
  deleteRole(input: {
    readonly roleId: string;
    readonly expectedVersion: number;
    readonly audit: AuditDecisionInput;
  }): Promise<'deleted' | 'not_found' | 'protected' | 'version_conflict' | 'assigned' | 'actor_denied'>;
  assignRole(input: {
    readonly adminId: string;
    readonly roleId: string;
    readonly assignedBy: string;
    readonly audit: AuditDecisionInput;
  }): Promise<
    | 'assigned'
    | 'already_assigned'
    | 'admin_inactive'
    | 'role_not_found'
    | 'actor_denied'
    | 'protected_role_denied'
    | 'capability_exceeded'
  >;
  revokeRole(input: {
    readonly adminId: string;
    readonly roleId: string;
    readonly expectedAssignment: boolean;
    readonly audit: AuditDecisionInput;
  }): Promise<'revoked' | 'not_assigned' | 'last_super_admin' | 'actor_denied' | 'protected_role_denied'>;
  disableAdmin(input: {
    readonly adminId: string;
    readonly audit: AuditDecisionInput;
  }): Promise<'disabled' | 'not_found' | 'last_super_admin' | 'actor_denied'>;
  queryAudit(input: AuditQueryInput): Promise<AuditPage>;
}

export interface SuperAdminBootstrapAuthorizer {
  authorize(proof: string): Promise<boolean>;
}
