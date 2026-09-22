import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { UuidSchema } from '@repo/contracts/common';

@Injectable()
export class AuthenticatedPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<unknown>();
    const principal =
      typeof request === 'object' && request !== null && 'principal' in request
        ? request.principal
        : undefined;
    const userId =
      typeof principal === 'object' && principal !== null && 'userId' in principal
        ? principal.userId
        : undefined;
    if (!UuidSchema.safeParse(userId).success) {
      throw new UnauthorizedException({
        code: 'UNAUTHENTICATED',
        message: 'Authentication is required.',
        retryable: false,
      });
    }
    return true;
  }
}
