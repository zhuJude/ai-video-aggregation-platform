import { errors as joseErrors, jwtVerify } from 'jose';

import { isUuidV7 } from '../domain/uuid-v7.js';

const ACCESS_TOKEN_MAX_LIFETIME_SECONDS = 15 * 60;
const ACCESS_TOKEN_FUTURE_IAT_TOLERANCE_SECONDS = 30;

export interface AccessVerificationKeyProvider {
  resolve(keyId: string): Promise<CryptoKey | null>;
}

export interface AccessSessionStatusRepository {
  isActive(userId: string, sessionId: string, now: Date): Promise<boolean>;
}

export interface JoseAccessTokenVerifierDependencies {
  readonly keyProvider: AccessVerificationKeyProvider;
  readonly statusRepository: AccessSessionStatusRepository;
  readonly now?: () => Date;
}

export interface VerifiedAccessPrincipal {
  readonly userId: string;
  readonly sessionId: string;
}

export class JoseAccessTokenVerifier {
  private readonly keyProvider: AccessVerificationKeyProvider;
  private readonly statusRepository: AccessSessionStatusRepository;
  private readonly now: () => Date;

  constructor(dependencies: JoseAccessTokenVerifierDependencies) {
    this.keyProvider = dependencies.keyProvider;
    this.statusRepository = dependencies.statusRepository;
    this.now = dependencies.now ?? (() => new Date());
  }

  async verify(token: string): Promise<VerifiedAccessPrincipal> {
    let userId: string;
    let sessionId: string;
    const now = this.now();
    try {
      const verified = await jwtVerify(
        token,
        async (protectedHeader) => {
          if (protectedHeader.alg !== 'EdDSA' || typeof protectedHeader.kid !== 'string') {
            throw new Error('UNSUPPORTED_ACCESS_KEY');
          }
          let key: CryptoKey | null;
          try {
            key = await this.keyProvider.resolve(protectedHeader.kid);
          } catch (error: unknown) {
            throw new AccessVerificationKeyDependencyError(error);
          }
          if (!key) throw new Error('UNKNOWN_ACCESS_KEY');
          return key;
        },
        {
          algorithms: ['EdDSA'],
          issuer: 'identity-service',
          audience: 'user-web',
          currentDate: now,
          requiredClaims: ['sub', 'sid', 'iat', 'exp'],
        },
      );
      userId = verified.payload.sub ?? '';
      sessionId = typeof verified.payload['sid'] === 'string' ? verified.payload['sid'] : '';
      if (!isUuidV7(userId) || !isUuidV7(sessionId)) {
        throw stableError('INVALID_ACCESS_TOKEN');
      }
      const issuedAt = verified.payload.iat;
      const expiresAt = verified.payload.exp;
      const nowSeconds = Math.floor(now.getTime() / 1000);
      if (
        typeof issuedAt !== 'number' ||
        typeof expiresAt !== 'number' ||
        !Number.isFinite(issuedAt) ||
        !Number.isFinite(expiresAt) ||
        expiresAt <= issuedAt ||
        expiresAt - issuedAt > ACCESS_TOKEN_MAX_LIFETIME_SECONDS ||
        issuedAt > nowSeconds + ACCESS_TOKEN_FUTURE_IAT_TOLERANCE_SECONDS
      ) {
        throw stableError('INVALID_ACCESS_TOKEN');
      }
    } catch (error: unknown) {
      if (error instanceof AccessVerificationKeyDependencyError) {
        throw error.dependencyError;
      }
      if (isAccessAuthenticationFailure(error)) {
        throw stableError('INVALID_ACCESS_TOKEN');
      }
      throw error;
    }
    if (!(await this.statusRepository.isActive(userId, sessionId, now))) {
      throw stableError('ACCESS_SESSION_INACTIVE');
    }
    return Object.freeze({ userId, sessionId });
  }
}

class AccessVerificationKeyDependencyError extends Error {
  constructor(readonly dependencyError: unknown) {
    super('ACCESS_VERIFICATION_KEY_DEPENDENCY_ERROR');
  }
}

function isAccessAuthenticationFailure(error: unknown): boolean {
  return (
    error instanceof joseErrors.JOSEError ||
    (error instanceof Error && 'code' in error && error.code === 'INVALID_ACCESS_TOKEN') ||
    (error instanceof Error &&
      (error.message === 'UNSUPPORTED_ACCESS_KEY' || error.message === 'UNKNOWN_ACCESS_KEY'))
  );
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
