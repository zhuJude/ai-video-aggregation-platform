import { createHash, randomBytes as nodeRandomBytes } from 'node:crypto';

import { assertUuidV7, generateUuidV7 } from '../domain/uuid-v7.js';
import type { AccessTokenIssuer } from '../ports/access-token-issuer.js';

const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export interface SessionRecord {
  id: string;
  userId: string;
  familyId: string;
  refreshTokenDigest: string;
  deviceName: string;
  expiresAt: Date;
  consumedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

export type CreateSessionRecord = Omit<SessionRecord, 'consumedAt' | 'revokedAt'>;

export interface RotateSessionInput {
  readonly presentedDigest: string;
  readonly now: Date;
  readonly successor: Pick<
    CreateSessionRecord,
    'id' | 'refreshTokenDigest' | 'expiresAt' | 'createdAt'
  >;
}

export type RotateSessionResult =
  | { readonly kind: 'rotated'; readonly session: SessionRecord }
  | { readonly kind: 'invalid' | 'reuse' | 'revoked' | 'expired' | 'user_inactive' };

export interface SessionRepository {
  create(input: CreateSessionRecord): Promise<SessionRecord>;
  rotate(input: RotateSessionInput): Promise<RotateSessionResult>;
  revokeById(userId: string, sessionId: string, now: Date): Promise<boolean>;
  revokeFamilyByDigest(digest: string, now: Date): Promise<void>;
  listActive(userId: string, now: Date): Promise<SessionRecord[]>;
}

export interface SessionServiceDependencies {
  readonly repository: SessionRepository;
  readonly accessTokenIssuer: AccessTokenIssuer;
  readonly now?: () => Date;
  readonly randomBytes?: () => Uint8Array;
  readonly uuidV7?: () => string;
}

export interface IssuedSession {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly session: SessionRecord;
}

export interface SessionSummary {
  readonly id: string;
  readonly deviceName: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

export class SessionService {
  private readonly repository: SessionRepository;
  private readonly accessTokenIssuer: AccessTokenIssuer;
  private readonly now: () => Date;
  private readonly secureRandomBytes: () => Uint8Array;
  private readonly nextUuid: () => string;

  constructor(dependencies: SessionServiceDependencies) {
    this.repository = dependencies.repository;
    this.accessTokenIssuer = dependencies.accessTokenIssuer;
    this.now = dependencies.now ?? (() => new Date());
    this.secureRandomBytes = dependencies.randomBytes ?? (() => nodeRandomBytes(32));
    this.nextUuid = dependencies.uuidV7 ?? generateUuidV7;
  }

  async create(userId: string, deviceName: string): Promise<IssuedSession> {
    validateDeviceName(deviceName);
    const now = this.now();
    const refreshToken = this.generateRefreshToken();
    const sessionId = this.nextUuid();
    const familyId = this.nextUuid();
    assertUuidV7(sessionId, 'INVALID_SESSION_ID');
    assertUuidV7(familyId, 'INVALID_SESSION_FAMILY_ID');
    const session = await this.repository.create({
      id: sessionId,
      userId,
      familyId,
      refreshTokenDigest: digestRefreshToken(refreshToken),
      deviceName: deviceName.trim(),
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
      createdAt: now,
    });
    return this.issuePair(session, refreshToken, now);
  }

  async rotate(refreshToken: string): Promise<IssuedSession> {
    validateRefreshToken(refreshToken);
    const now = this.now();
    const successorToken = this.generateRefreshToken();
    const successorId = this.nextUuid();
    assertUuidV7(successorId, 'INVALID_SESSION_ID');
    const result = await this.repository.rotate({
      presentedDigest: digestRefreshToken(refreshToken),
      now,
      successor: {
        id: successorId,
        refreshTokenDigest: digestRefreshToken(successorToken),
        expiresAt: new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_MS),
        createdAt: now,
      },
    });
    if (result.kind === 'rotated') return this.issuePair(result.session, successorToken, now);
    const errorByResult = {
      invalid: 'INVALID_REFRESH_TOKEN',
      reuse: 'REFRESH_REUSE_DETECTED',
      revoked: 'SESSION_REVOKED',
      expired: 'SESSION_EXPIRED',
      user_inactive: 'USER_INACTIVE',
    } as const;
    throw stableError(errorByResult[result.kind]);
  }

  async logout(refreshToken: string): Promise<void> {
    validateRefreshToken(refreshToken);
    await this.repository.revokeFamilyByDigest(digestRefreshToken(refreshToken), this.now());
  }

  async revoke(userId: string, sessionId: string): Promise<void> {
    if (!(await this.repository.revokeById(userId, sessionId, this.now()))) {
      throw stableError('SESSION_NOT_FOUND');
    }
  }

  async list(userId: string): Promise<SessionSummary[]> {
    const sessions = await this.repository.listActive(userId, this.now());
    return sessions.map(({ id, deviceName, createdAt, expiresAt }) => ({
      id,
      deviceName,
      createdAt,
      expiresAt,
    }));
  }

  private generateRefreshToken(): string {
    const entropy = this.secureRandomBytes();
    if (entropy.byteLength < 32) throw stableError('INSUFFICIENT_REFRESH_TOKEN_ENTROPY');
    return Buffer.from(entropy).subarray(0, 32).toString('base64url');
  }

  private async issuePair(
    session: SessionRecord,
    refreshToken: string,
    issuedAt: Date,
  ): Promise<IssuedSession> {
    return {
      accessToken: await this.accessTokenIssuer.issue({
        userId: session.userId,
        sessionId: session.id,
        issuedAt,
      }),
      refreshToken,
      session,
    };
  }
}

function digestRefreshToken(refreshToken: string): string {
  return createHash('sha256').update(refreshToken, 'ascii').digest('hex');
}

function validateRefreshToken(refreshToken: string): void {
  if (!REFRESH_TOKEN_PATTERN.test(refreshToken)) throw stableError('INVALID_REFRESH_TOKEN');
}

function validateDeviceName(deviceName: string): void {
  const normalized = deviceName.trim();
  if (!normalized || normalized.length > 120) throw stableError('INVALID_DEVICE_NAME');
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
