const AUTHENTICATED_USER_BRAND = new WeakSet<object>();

export class AuthenticatedUser {
  private constructor(
    readonly userId: string,
    readonly sessionId: string,
  ) {
    AUTHENTICATED_USER_BRAND.add(this);
    Object.freeze(this);
  }

  static fromGuard(userId: string, sessionId: string): AuthenticatedUser {
    if (!isUuidV7(userId) || !isUuidV7(sessionId)) {
      throw stableError('INVALID_AUTHENTICATED_USER');
    }
    return new AuthenticatedUser(userId, sessionId);
  }

  static assertTrusted(principal: AuthenticatedUser): AuthenticatedUser {
    if (!AUTHENTICATED_USER_BRAND.has(principal)) {
      throw stableError('UNTRUSTED_AUTHENTICATED_USER');
    }
    return principal;
  }
}

Object.freeze(AuthenticatedUser.prototype);
Object.freeze(AuthenticatedUser);

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
import { isUuidV7 } from '../domain/uuid-v7.js';
