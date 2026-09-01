import { SignJWT } from 'jose';

import type { AccessTokenClaims, AccessTokenIssuer } from '../ports/access-token-issuer.js';

const ACCESS_TOKEN_LIFETIME_SECONDS = 15 * 60;

export interface JoseAccessTokenIssuerOptions {
  readonly keyId: string;
  readonly signingKey: CryptoKey;
}

export class JoseAccessTokenIssuer implements AccessTokenIssuer {
  constructor(private readonly options: JoseAccessTokenIssuerOptions) {
    if (!options.keyId.trim()) throw stableError('INVALID_SIGNING_KEY_REFERENCE');
  }

  issue(claims: AccessTokenClaims): Promise<string> {
    const issuedAtSeconds = Math.floor(claims.issuedAt.getTime() / 1000);
    return new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.options.keyId, typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer('identity-service')
      .setAudience('user-web')
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + ACCESS_TOKEN_LIFETIME_SECONDS)
      .sign(this.options.signingKey);
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
