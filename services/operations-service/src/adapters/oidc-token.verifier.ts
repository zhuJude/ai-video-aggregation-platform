import { createRemoteJWKSet, jwtVerify } from 'jose';
import type {
  AdminTokenClaims,
  AdminTokenVerifier,
  UserTokenVerifier,
} from '../http/http-auth.adapters.js';

export class OidcTokenVerifier implements AdminTokenVerifier, UserTokenVerifier {
  private readonly keys;
  constructor(private readonly input: { jwksUrl: URL; issuer: string; audience: string }) {
    this.keys = createRemoteJWKSet(input.jwksUrl, {
      timeoutDuration: 2_000,
      cooldownDuration: 30_000,
    });
  }
  async verify(token: string): Promise<AdminTokenClaims> {
    const { payload } = await jwtVerify(token, this.keys, {
      issuer: this.input.issuer,
      audience: this.input.audience,
      algorithms: ['RS256', 'ES256'],
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.iss !== 'string' ||
      typeof payload.token_use !== 'string'
    )
      throw Object.assign(new Error('JWT_CLAIMS_INVALID'), { code: 'JWT_CLAIMS_INVALID' });
    const base = {
      sub: payload.sub,
      tokenUse: payload.token_use,
      issuer: payload.iss,
      audience: payload.aud ?? [],
    };
    return {
      ...base,
      role: typeof payload.role === 'string' ? payload.role : '',
      permissions: payload.permissions ?? [],
    };
  }
  async ping(): Promise<void> {
    const response = await fetch(this.input.jwksUrl, { signal: AbortSignal.timeout(2_000) });
    if (!response.ok) throw new Error('OIDC_JWKS_UNAVAILABLE');
    const body = (await response.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys) || body.keys.length === 0) throw new Error('OIDC_JWKS_INVALID');
  }
}
