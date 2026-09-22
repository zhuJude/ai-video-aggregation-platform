import { createHash } from 'node:crypto';

import { decodeJwt, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';

import { JoseAccessTokenIssuer } from '../src/adapters/jose-access-token.issuer.js';
import {
  SessionService,
  type CreateSessionRecord,
  type RotateSessionInput,
  type SessionRecord,
  type SessionRepository,
} from '../src/application/session.service.js';

class MemorySessionRepository implements SessionRepository {
  readonly sessions = new Map<string, SessionRecord>();
  readonly storedDigests: string[] = [];
  userStatus = 'ACTIVE';

  create(input: CreateSessionRecord): Promise<SessionRecord> {
    const record = { ...input, consumedAt: null, revokedAt: null };
    this.sessions.set(record.id, record);
    this.storedDigests.push(record.refreshTokenDigest);
    return Promise.resolve(record);
  }

  rotate(input: RotateSessionInput) {
    const current = [...this.sessions.values()].find(
      (session) => session.refreshTokenDigest === input.presentedDigest,
    );
    if (!current) return Promise.resolve({ kind: 'invalid' } as const);
    if (current.consumedAt) {
      for (const session of this.sessions.values()) {
        if (session.familyId === current.familyId && !session.revokedAt)
          session.revokedAt = input.now;
      }
      return Promise.resolve({ kind: 'reuse' } as const);
    }
    if (current.revokedAt) return Promise.resolve({ kind: 'revoked' } as const);
    if (current.expiresAt <= input.now) return Promise.resolve({ kind: 'expired' } as const);
    if (this.userStatus !== 'ACTIVE') return Promise.resolve({ kind: 'user_inactive' } as const);

    current.consumedAt = input.now;
    const successor: SessionRecord = {
      ...input.successor,
      userId: current.userId,
      familyId: current.familyId,
      deviceName: current.deviceName,
      consumedAt: null,
      revokedAt: null,
    };
    this.sessions.set(successor.id, successor);
    this.storedDigests.push(successor.refreshTokenDigest);
    return Promise.resolve({ kind: 'rotated', session: successor } as const);
  }

  revokeById(userId: string, sessionId: string, now: Date): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session || session.userId !== userId) return Promise.resolve(false);
    session.revokedAt ??= now;
    return Promise.resolve(true);
  }

  revokeFamilyByDigest(digest: string, now: Date): Promise<void> {
    const current = [...this.sessions.values()].find(
      (session) => session.refreshTokenDigest === digest,
    );
    if (current) {
      for (const session of this.sessions.values()) {
        if (session.familyId === current.familyId) session.revokedAt ??= now;
      }
    }
    return Promise.resolve();
  }

  listActive(userId: string, now: Date): Promise<SessionRecord[]> {
    return Promise.resolve(
      [...this.sessions.values()].filter(
        (session) =>
          session.userId === userId &&
          !session.revokedAt &&
          !session.consumedAt &&
          session.expiresAt > now,
      ),
    );
  }
}

async function fixture() {
  const repository = new MemorySessionRepository();
  const { privateKey, publicKey } = await globalThis.crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ]);
  let nowMs = Date.UTC(2026, 7, 31, 12, 0, 0);
  let sequence = 0;
  const service = new SessionService({
    repository,
    accessTokenIssuer: new JoseAccessTokenIssuer({
      keyId: 'identity-signing-v1',
      signingKey: privateKey,
    }),
    now: () => new Date(nowMs),
    randomBytes: () => Buffer.alloc(32, ++sequence),
    uuidV7: () => `0198fabc-1234-7abc-8abc-${String(++sequence).padStart(12, '0')}`,
  });
  return {
    repository,
    service,
    publicKey,
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
  };
}

describe('SessionService', () => {
  it('stores only SHA-256 refresh digests and issues a 15-minute scoped access JWT', async () => {
    const { publicKey, repository, service } = await fixture();
    const result = await service.create('11111111-1111-4111-8111-111111111111', 'Chrome');

    expect(result.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(result.session.id).toMatch(/-7[0-9a-f]{3}-[89ab]/);
    expect(result.session.familyId).toMatch(/-7[0-9a-f]{3}-[89ab]/);
    expect(JSON.stringify([...repository.sessions.values()])).not.toContain(result.refreshToken);
    expect(repository.storedDigests).toContain(
      createHash('sha256').update(result.refreshToken).digest('hex'),
    );
    const verified = await jwtVerify(result.accessToken, publicKey, {
      issuer: 'identity-service',
      audience: 'user-web',
      currentDate: new Date(Date.UTC(2026, 7, 31, 12, 0, 0)),
    });
    expect(verified.payload).toMatchObject({
      sub: '11111111-1111-4111-8111-111111111111',
      sid: result.session.id,
      iss: 'identity-service',
      aud: 'user-web',
    });
    expect(verified.payload.exp).toBeTypeOf('number');
    expect(verified.payload.iat).toBeTypeOf('number');
    if (typeof verified.payload.exp !== 'number' || typeof verified.payload.iat !== 'number') {
      throw new Error('EXPECTED_JWT_TIMESTAMPS');
    }
    expect(verified.payload.exp - verified.payload.iat).toBe(15 * 60);
    expect(decodeJwt(result.accessToken)).not.toHaveProperty('refreshToken');
  });

  it('rotates refresh tokens and revokes the entire family on consumed-token reuse', async () => {
    const { repository, service } = await fixture();
    const first = await service.create('11111111-1111-4111-8111-111111111111', 'Chrome');
    const rotated = await service.rotate(first.refreshToken);

    expect(rotated.refreshToken).not.toBe(first.refreshToken);
    await expect(service.rotate(first.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_REUSE_DETECTED',
    });
    await expect(service.rotate(rotated.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
    expect(
      [...repository.sessions.values()].filter(
        (session) => session.familyId === first.session.familyId,
      ),
    ).toSatisfy((sessions: SessionRecord[]) => sessions.every((session) => session.revokedAt));
  });

  it('treats concurrent rotation as reuse and leaves no usable family token', async () => {
    const { service } = await fixture();
    const first = await service.create('11111111-1111-4111-8111-111111111111', 'Chrome');

    const settled = await Promise.allSettled([
      service.rotate(first.refreshToken),
      service.rotate(first.refreshToken),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const successful = settled.find((result) => result.status === 'fulfilled');
    if (successful?.status !== 'fulfilled') throw new Error('EXPECTED_ROTATION');
    await expect(service.rotate(successful.value.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });

  it('rejects malformed, expired, revoked, and inactive-user refresh tokens with stable errors', async () => {
    const firstFixture = await fixture();
    await expect(firstFixture.service.rotate('plaintext')).rejects.toMatchObject({
      code: 'INVALID_REFRESH_TOKEN',
    });

    const expiredFixture = await fixture();
    const expired = await expiredFixture.service.create(
      '11111111-1111-4111-8111-111111111111',
      'Chrome',
    );
    expiredFixture.advance(31 * 24 * 60 * 60 * 1000);
    await expect(expiredFixture.service.rotate(expired.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_EXPIRED',
    });

    const revokedFixture = await fixture();
    const revoked = await revokedFixture.service.create(
      '11111111-1111-4111-8111-111111111111',
      'Chrome',
    );
    await revokedFixture.service.logout(revoked.refreshToken);
    await expect(revokedFixture.service.rotate(revoked.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });

    const inactiveFixture = await fixture();
    const inactive = await inactiveFixture.service.create(
      '11111111-1111-4111-8111-111111111111',
      'Chrome',
    );
    inactiveFixture.repository.userStatus = 'CLOSED';
    await expect(inactiveFixture.service.rotate(inactive.refreshToken)).rejects.toMatchObject({
      code: 'USER_INACTIVE',
    });
  });

  it('lists only current active sessions and revokes only a session owned by the user', async () => {
    const { service } = await fixture();
    const first = await service.create('11111111-1111-4111-8111-111111111111', 'Chrome');
    const second = await service.create('11111111-1111-4111-8111-111111111111', 'Safari');
    await expect(
      service.revoke('22222222-2222-4222-8222-222222222222', first.session.id),
    ).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
    await service.revoke('11111111-1111-4111-8111-111111111111', first.session.id);

    const listed = await service.list('11111111-1111-4111-8111-111111111111');
    expect(listed).toEqual([
      expect.objectContaining({ id: second.session.id, deviceName: 'Safari' }),
    ]);
    expect(listed[0]).not.toHaveProperty('refreshTokenDigest');
    expect(listed[0]).not.toHaveProperty('familyId');
  });
});
