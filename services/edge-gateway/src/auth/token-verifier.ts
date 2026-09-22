import { PermissionKeySchema } from '@repo/contracts/iam';
import { decodeProtectedHeader, jwtVerify, SignJWT, type CryptoKey, type JWTPayload } from 'jose';
import type {
  AdminSubject,
  AuthenticatedSubject,
  DataScope,
  RequestContext,
  UserSubject,
} from './subject.js';

interface BrowserTokenPolicy {
  readonly algorithms: readonly string[];
  readonly audience: string;
  readonly issuer: string;
  readonly keys: ReadonlyMap<string, CryptoKey>;
}

interface InternalSigner {
  readonly algorithm: string;
  readonly audience: string;
  readonly issuer: string;
  readonly kid: string;
  readonly privateKey: CryptoKey;
}

export interface TokenVerifierConfig {
  readonly admin: BrowserTokenPolicy;
  readonly internalSigner: InternalSigner;
  readonly user: BrowserTokenPolicy;
}

export class TokenVerificationError extends Error {
  constructor(readonly code: 'INVALID_ADMIN_TOKEN' | 'INVALID_USER_TOKEN') {
    super(code);
    this.name = 'TokenVerificationError';
  }
}

const DATA_SCOPES = new Set<DataScope>(['ALL', 'OWN', 'ASSIGNED']);

function requireBaseClaims(payload: JWTPayload): { sessionId: string; subjectId: string } {
  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw new Error('missing required subject claims');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.iat !== 'number' || payload.iat > now + 5) {
    throw new Error('invalid token issue time');
  }
  return { sessionId: payload.sid, subjectId: payload.sub };
}

function requireAdminClaims(payload: JWTPayload): {
  dataScope: DataScope;
  permissions: string[];
} {
  if (!Array.isArray(payload.permissions)) {
    throw new Error('missing permissions');
  }
  const permissions = payload.permissions.map((permission) =>
    PermissionKeySchema.parse(permission),
  );
  const dataScope = payload.dataScope;
  if (typeof dataScope !== 'string' || !DATA_SCOPES.has(dataScope as DataScope)) {
    throw new Error('invalid data scope');
  }
  return { dataScope: dataScope as DataScope, permissions };
}

export class TokenVerifier {
  constructor(private readonly config: TokenVerifierConfig) {}

  async verifyUser(token: string): Promise<UserSubject> {
    try {
      const payload = await this.verify(token, this.config.user);
      return { kind: 'user', ...requireBaseClaims(payload) };
    } catch {
      throw new TokenVerificationError('INVALID_USER_TOKEN');
    }
  }

  async verifyAdmin(token: string): Promise<AdminSubject> {
    try {
      const payload = await this.verify(token, this.config.admin);
      return {
        kind: 'admin',
        ...requireBaseClaims(payload),
        ...requireAdminClaims(payload),
      };
    } catch {
      throw new TokenVerificationError('INVALID_ADMIN_TOKEN');
    }
  }

  async createInternalSubjectAssertion(
    subject: AuthenticatedSubject,
    context: RequestContext,
  ): Promise<string> {
    const signer = this.config.internalSigner;
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      correlationId: context.correlationId,
      sid: subject.sessionId,
      subjectKind: subject.kind,
      traceId: context.traceId,
      ...(subject.kind === 'admin'
        ? { dataScope: subject.dataScope, permissions: subject.permissions }
        : {}),
    };

    return new SignJWT(claims)
      .setProtectedHeader({ alg: signer.algorithm, kid: signer.kid, typ: 'JWT' })
      .setIssuer(signer.issuer)
      .setAudience(signer.audience)
      .setSubject(subject.subjectId)
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(signer.privateKey);
  }

  private async verify(token: string, policy: BrowserTokenPolicy): Promise<JWTPayload> {
    const header = decodeProtectedHeader(token);
    if (
      typeof header.alg !== 'string' ||
      header.alg === 'none' ||
      typeof header.kid !== 'string' ||
      !policy.algorithms.includes(header.alg)
    ) {
      throw new Error('untrusted JWT header');
    }
    const key = policy.keys.get(header.kid);
    if (key === undefined) {
      throw new Error('unknown signing key');
    }
    const result = await jwtVerify(token, key, {
      algorithms: [...policy.algorithms],
      audience: policy.audience,
      clockTolerance: 5,
      issuer: policy.issuer,
    });
    return result.payload;
  }
}
