import { SignJWT } from 'jose';

import type {
  AdminAccessTokenClaims,
  AdminAccessTokenIssuer,
  AdminSigningKeyProvider,
} from '../ports/admin-access-token.js';

const ACCESS_TOKEN_LIFETIME_SECONDS = 10 * 60;

export class JoseAdminAccessTokenIssuer implements AdminAccessTokenIssuer {
  constructor(private readonly keyProvider: AdminSigningKeyProvider) {}

  async issue(claims: AdminAccessTokenClaims): Promise<string> {
    const { keyId, signingKey } = await this.keyProvider.getCurrentSigningKey();
    if (!keyId.trim()) throw stableError('INVALID_SIGNING_KEY_REFERENCE');
    const issuedAtSeconds = Math.floor(claims.issuedAt.getTime() / 1_000);
    return new SignJWT({ sid: claims.sessionId })
      .setProtectedHeader({ alg: 'EdDSA', kid: keyId, typ: 'JWT' })
      .setSubject(claims.adminId)
      .setIssuer('iam-service')
      .setAudience('admin-web')
      .setIssuedAt(issuedAtSeconds)
      .setExpirationTime(issuedAtSeconds + ACCESS_TOKEN_LIFETIME_SECONDS)
      .sign(signingKey);
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
