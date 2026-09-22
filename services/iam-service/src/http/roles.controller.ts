import {
  Body,
  type CanActivate,
  Controller,
  Delete,
  Get,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  type ExecutionContext,
  UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import type { IamAdministrationService } from '../application/iam-administration.service.js';
import type { DataScope } from '../domain/authorization.js';
import { isUuidV7 } from '../domain/uuid-v7.js';

interface AuthenticatedAdmin {
  readonly adminId: string;
  readonly sessionId: string;
}
const VERIFIED_REQUESTS = new WeakMap<object, AuthenticatedAdmin>();

function bindVerifiedRequest(
  request: AdminHttpRequest,
  adminId: string,
  sessionId: string,
): void {
  if (!isUuidV7(adminId) || !isUuidV7(sessionId)) throw stableError('INVALID_ADMIN_PRINCIPAL');
  VERIFIED_REQUESTS.set(request, Object.freeze({ adminId, sessionId }));
}

export interface AdminAccessVerifier {
  verify(token: string): Promise<{ readonly adminId: string; readonly sessionId: string }>;
}

@Injectable()
export class IamAdminGuard implements CanActivate {
  constructor(@Inject('ADMIN_ACCESS_VERIFIER') private readonly verifier: AdminAccessVerifier) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AdminHttpRequest>();
    const authorization = singleHeader(request.headers.authorization);
    const match = authorization ? /^Bearer ([A-Za-z0-9._~-]{1,4096})$/.exec(authorization) : null;
    if (!match?.[1]) throw stableError('INVALID_ADMIN_ACCESS_TOKEN');
    let verified: { readonly adminId: string; readonly sessionId: string };
    try {
      verified = await this.verifier.verify(match[1]);
    } catch (error: unknown) {
      if (stableCode(error) === 'ADMIN_ACCESS_SESSION_INACTIVE') throw error;
      throw stableError('INVALID_ADMIN_ACCESS_TOKEN');
    }
    bindVerifiedRequest(request, verified.adminId, verified.sessionId);
    return true;
  }
}

type AdminHttpRequest = Pick<FastifyRequest, 'headers' | 'ip'>;

@Controller('v1/iam')
export class RolesController {
  constructor(
    @Inject('IAM_ADMINISTRATION_SERVICE')
    private readonly service: IamAdministrationService,
  ) {}

  @Get('permissions')
  @UseGuards(IamAdminGuard)
  listPermissions(@Req() request: AdminHttpRequest) {
    const principal = principalFromRequest(request);
    return this.service.listPermissions(managementContext(principal, request));
  }

  @Get('roles')
  @UseGuards(IamAdminGuard)
  listRoles(@Req() request: AdminHttpRequest, @Query() rawQuery: unknown) {
    const principal = principalFromRequest(request);
    const query = exactRecord(rawQuery, ['cursor', 'limit']);
    const cursor = optionalString(query['cursor']);
    return this.service.listRoles({
      context: managementContext(principal, request),
      ...(cursor ? { cursor } : {}),
      ...(query['limit'] !== undefined ? { limit: positiveInteger(query['limit']) } : {}),
    });
  }

  @Post('roles')
  @UseGuards(IamAdminGuard)
  createRole(
    @Req() request: AdminHttpRequest,
    @Body() rawBody: unknown,
  ) {
    const trusted = principalFromRequest(request);
    const body = roleBody(rawBody, false);
    return this.service.createRole({
      ...body,
      context: managementContext(trusted, request),
    });
  }

  @Patch('roles/:roleId')
  @UseGuards(IamAdminGuard)
  updateRole(
    @Req() request: AdminHttpRequest,
    @Param('roleId') rawRoleId: unknown,
    @Body() rawBody: unknown,
  ) {
    const principal = principalFromRequest(request);
    const body = roleBody(rawBody, true);
    return this.service.updateRole({
      roleId: uuidV7(rawRoleId),
      expectedVersion: body.expectedVersion,
      name: body.name,
      description: body.description,
      dataScope: body.dataScope,
      permissionKeys: body.permissionKeys,
      context: managementContext(principal, request),
    });
  }

  @Delete('roles/:roleId')
  @UseGuards(IamAdminGuard)
  deleteRole(
    @Req() request: AdminHttpRequest,
    @Param('roleId') rawRoleId: unknown,
    @Query('expectedVersion') rawVersion: unknown,
  ) {
    return this.service.deleteRole({
      roleId: uuidV7(rawRoleId),
      expectedVersion: positiveInteger(rawVersion),
      context: managementContext(principalFromRequest(request), request),
    });
  }

  @Put('admins/:adminId/roles/:roleId')
  @UseGuards(IamAdminGuard)
  assignRole(
    @Req() request: AdminHttpRequest,
    @Param('adminId') rawAdminId: unknown,
    @Param('roleId') rawRoleId: unknown,
  ) {
    return this.service.assignRole({
      adminId: uuidV7(rawAdminId),
      roleId: uuidV7(rawRoleId),
      context: managementContext(principalFromRequest(request), request),
    });
  }

  @Delete('admins/:adminId/roles/:roleId')
  @UseGuards(IamAdminGuard)
  revokeRole(
    @Req() request: AdminHttpRequest,
    @Param('adminId') rawAdminId: unknown,
    @Param('roleId') rawRoleId: unknown,
  ) {
    return this.service.revokeRole({
      adminId: uuidV7(rawAdminId),
      roleId: uuidV7(rawRoleId),
      expectedAssignment: true,
      context: managementContext(principalFromRequest(request), request),
    });
  }

  @Post('admins/:adminId/disable')
  @UseGuards(IamAdminGuard)
  disableAdmin(
    @Req() request: AdminHttpRequest,
    @Param('adminId') rawAdminId: unknown,
  ) {
    return this.service.disableAdmin({
      adminId: uuidV7(rawAdminId),
      context: managementContext(principalFromRequest(request), request),
    });
  }

  @Get('audit-events')
  @UseGuards(IamAdminGuard)
  queryAudit(@Req() request: AdminHttpRequest, @Query() rawQuery: unknown) {
    const query = exactRecord(rawQuery, [
      'actorId',
      'action',
      'resourceType',
      'resourceId',
      'outcome',
      'from',
      'to',
      'cursor',
      'limit',
    ]);
    const actorId = optionalString(query['actorId']);
    const action = optionalString(query['action']);
    const resourceType = optionalString(query['resourceType']);
    const resourceId = optionalString(query['resourceId']);
    const outcome = optionalString(query['outcome']);
    const from = optionalDate(query['from']);
    const to = optionalDate(query['to']);
    const cursor = optionalString(query['cursor']);
    return this.service.queryAudit({
      context: managementContext(principalFromRequest(request), request),
      ...(actorId ? { actorId } : {}),
      ...(action ? { action } : {}),
      ...(resourceType ? { resourceType } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(outcome ? { outcome: outcome as 'SUCCESS' | 'DENIED' } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      ...(cursor ? { cursor } : {}),
      ...(query['limit'] !== undefined ? { limit: positiveInteger(query['limit']) } : {}),
    });
  }
}

function roleBody(input: unknown, withVersion: true): RoleInput & { readonly expectedVersion: number };
function roleBody(input: unknown, withVersion: false): RoleInput;
function roleBody(input: unknown, withVersion: boolean): RoleInput & { readonly expectedVersion?: number } {
  const body = exactRecord(
    input,
    withVersion
      ? ['name', 'description', 'dataScope', 'permissionKeys', 'expectedVersion']
      : ['name', 'description', 'dataScope', 'permissionKeys'],
  );
  const dataScope = requiredString(body['dataScope']);
  if (dataScope !== 'ALL' && dataScope !== 'OWN' && dataScope !== 'ASSIGNED') {
    throw invalidRequest();
  }
  const permissionKeys = body['permissionKeys'];
  if (!Array.isArray(permissionKeys) || permissionKeys.some((value) => typeof value !== 'string')) {
    throw invalidRequest();
  }
  return {
    name: requiredString(body['name']),
    description: requiredString(body['description']),
    dataScope,
    permissionKeys,
    ...(withVersion ? { expectedVersion: positiveInteger(body['expectedVersion']) } : {}),
  };
}

interface RoleInput {
  readonly name: string;
  readonly description: string;
  readonly dataScope: DataScope;
  readonly permissionKeys: readonly string[];
}

function principalFromRequest(request: AdminHttpRequest): AuthenticatedAdmin {
  const principal = VERIFIED_REQUESTS.get(request);
  if (!principal) throw stableError('UNTRUSTED_ADMIN_PRINCIPAL');
  return principal;
}

function managementContext(principal: AuthenticatedAdmin, request: AdminHttpRequest) {
  const traceId = requiredHeader(request, 'x-trace-id');
  const correlationId = requiredHeader(request, 'x-correlation-id');
  const causationId = optionalHeader(request, 'x-causation-id');
  return {
    actorId: principal.adminId,
    ipAddress: request.ip,
    userAgent: requiredHeader(request, 'user-agent'),
    traceId,
    correlationId,
    ...(causationId ? { causationId } : {}),
    occurredAt: new Date(),
  };
}

function requiredHeader(request: AdminHttpRequest, name: string): string {
  const value = optionalHeader(request, name);
  if (!value) throw invalidRequest();
  return value;
}

function optionalHeader(request: AdminHttpRequest, name: string): string | undefined {
  return singleHeader(request.headers[name]);
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function exactRecord(input: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidRequest();
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalidRequest();
  return record;
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string') throw invalidRequest();
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value);
}

function positiveInteger(value: unknown): number {
  const number = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) {
    throw invalidRequest();
  }
  return number;
}

function optionalDate(value: unknown): Date | undefined {
  if (value === undefined) return undefined;
  const raw = requiredString(value);
  const date = new Date(raw);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(raw) || !Number.isFinite(date.getTime())) throw invalidRequest();
  return date;
}

function uuidV7(value: unknown): string {
  if (typeof value !== 'string' || !isUuidV7(value)) throw invalidRequest();
  return value;
}

function stableCode(error: unknown): string | null {
  return error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code
    : null;
}

function invalidRequest(): Error & { code: 'INVALID_REQUEST' } {
  return Object.assign(new Error('INVALID_REQUEST'), { code: 'INVALID_REQUEST' as const });
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
