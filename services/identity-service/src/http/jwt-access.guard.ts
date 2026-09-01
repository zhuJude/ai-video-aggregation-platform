import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import type { JoseAccessTokenVerifier } from '../adapters/jose-access-token.verifier.js';
import { AuthenticatedUser } from './authenticated-user.js';

@Injectable()
export class JwtAccessGuard implements CanActivate {
  constructor(
    @Inject('ACCESS_TOKEN_VERIFIER') private readonly verifier: JoseAccessTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string | string[] };
      user?: AuthenticatedUser;
    }>();
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string') throw unauthorized('INVALID_ACCESS_TOKEN');
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization);
    if (!match?.[1]) throw unauthorized('INVALID_ACCESS_TOKEN');
    let verified: { readonly userId: string; readonly sessionId: string };
    try {
      verified = await this.verifier.verify(match[1]);
    } catch (error: unknown) {
      const code = authenticationErrorCode(error);
      if (code) throw unauthorized(code);
      throw error;
    }
    request.user = AuthenticatedUser.fromGuard(verified.userId, verified.sessionId);
    return true;
  }
}

function unauthorized(code: string): UnauthorizedException & { code: string } {
  return Object.assign(new UnauthorizedException({ code }), { code });
}

function authenticationErrorCode(
  error: unknown,
): 'INVALID_ACCESS_TOKEN' | 'ACCESS_SESSION_INACTIVE' | null {
  if (!(error instanceof Error) || !('code' in error)) return null;
  return error.code === 'INVALID_ACCESS_TOKEN' || error.code === 'ACCESS_SESSION_INACTIVE'
    ? error.code
    : null;
}
