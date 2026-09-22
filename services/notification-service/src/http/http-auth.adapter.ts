import type { RawHeaders, UserAuthenticator, UserPrincipal } from './notification-http.module.js';
import { UUID_V7_PATTERN } from '../domain/uuid-v7.js';

export interface UserTokenClaims {
  sub: string;
  tokenUse: string;
  issuer: string;
  audience: string | readonly string[];
}
export interface UserTokenVerifier {
  verify(token: string): Promise<UserTokenClaims>;
}

/** There is intentionally no development credential fallback. */
export class JwksUserAuthenticator implements UserAuthenticator {
  constructor(
    private readonly verifier: UserTokenVerifier,
    private readonly expected: { issuer: string; audience: string },
  ) {}
  async authenticate(request: { headers: RawHeaders }): Promise<UserPrincipal | null> {
    const authorization = request.headers.authorization;
    if (typeof authorization !== 'string') return null;
    const token = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(authorization)?.[1];
    if (token === undefined) return null;
    let claims: UserTokenClaims;
    try {
      claims = await this.verifier.verify(token);
    } catch {
      return null;
    }
    const audience = typeof claims.audience === 'string' ? [claims.audience] : claims.audience;
    if (
      claims.tokenUse !== 'user' ||
      claims.issuer !== this.expected.issuer ||
      !audience.includes(this.expected.audience) ||
      !UUID_V7_PATTERN.test(claims.sub)
    )
      return null;
    return { userId: claims.sub };
  }
}
