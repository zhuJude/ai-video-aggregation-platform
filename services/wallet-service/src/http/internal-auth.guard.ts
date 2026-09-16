import { timingSafeEqual } from 'node:crypto';
import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

export const INTERNAL_AUTH_OPTIONS = Symbol('INTERNAL_AUTH_OPTIONS');

export interface InternalAuthOptions {
  bearerSecret: string;
  allowedServices: ReadonlySet<string>;
}

interface HeaderRequest {
  headers: Record<string, string | string[] | undefined>;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function equalSecret(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

@Injectable()
export class InternalAuthGuard implements CanActivate {
  constructor(@Inject(INTERNAL_AUTH_OPTIONS) private readonly options: InternalAuthOptions) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<HeaderRequest>();
    const serviceName = singleHeader(request.headers['x-internal-service']);
    const authorization = singleHeader(request.headers.authorization);
    const prefix = 'Bearer ';
    const providedSecret = authorization?.startsWith(prefix)
      ? authorization.slice(prefix.length)
      : '';

    if (
      !serviceName ||
      !this.options.allowedServices.has(serviceName) ||
      !equalSecret(providedSecret, this.options.bearerSecret)
    ) {
      throw new UnauthorizedException('INTERNAL_AUTHENTICATION_REQUIRED');
    }
    return true;
  }
}

@Injectable()
export class UserAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ user?: { userId?: unknown } }>();
    if (typeof request.user?.userId !== 'string') {
      throw new UnauthorizedException('USER_AUTHENTICATION_REQUIRED');
    }
    return true;
  }
}
