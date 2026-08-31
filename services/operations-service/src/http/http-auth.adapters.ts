import type { AdminAuthenticator, AdminPrincipal, RawHeaders } from './operations-http.module.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface AdminTokenClaims {
  sub: string;
  tokenUse: string;
  role: string;
  permissions: unknown;
  issuer: string;
  audience: string | readonly string[];
}

export interface AdminTokenVerifier {
  verify(token: string): Promise<AdminTokenClaims>;
}

/** Production JWKS seam. Only cryptographically verified claims become a principal. */
export class JwksAdminAuthenticator implements AdminAuthenticator {
  constructor(
    private readonly verifier: AdminTokenVerifier,
    private readonly expected: { issuer: string; audience: string },
  ) {}

  async authenticate(request: { headers: RawHeaders }): Promise<AdminPrincipal | null> {
    const value = request.headers.authorization;
    if (typeof value !== 'string') return null;
    const match = /^Bearer ([A-Za-z0-9._~-]+)$/.exec(value);
    if (match === null) return null;
    let claims: AdminTokenClaims;
    try { claims = await this.verifier.verify(match[1] ?? ''); }
    catch (error) { if (isInvalidToken(error)) return null; throw error; }
    if (claims.tokenUse !== 'admin' || claims.issuer !== this.expected.issuer || !hasAudience(claims.audience, this.expected.audience) || !UUID_PATTERN.test(claims.sub)) return null;
    if (claims.role !== 'OWNER' && claims.role !== 'ADMIN' && claims.role !== 'VIEWER') return null;
    if (!Array.isArray(claims.permissions) || !claims.permissions.every((permission) => typeof permission === 'string')) return null;
    return { adminId: claims.sub, role: claims.role, permissions: [...claims.permissions] as string[] };
  }
}

function hasAudience(actual: string | readonly string[], expected: string): boolean {
  return typeof actual === 'string' ? actual === expected : actual.includes(expected);
}

function isInvalidToken(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  return [
    'JWT_INVALID', 'JWT_EXPIRED', 'JWT_SIGNATURE_INVALID', 'JWT_CLAIMS_INVALID',
    'ERR_JWT_INVALID', 'ERR_JWT_EXPIRED', 'ERR_JWT_CLAIM_VALIDATION_FAILED',
    'ERR_JWS_INVALID', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED',
  ].includes(String(error.code));
}
