import { generate } from 'otplib';
import { describe, expect, it, vi } from 'vitest';

import { LocalAesGcmSecretCipher } from '../src/adapters/local-aes-gcm-secret.cipher.js';
import { MemoryAdminAccessCoordinator } from '../src/adapters/memory-admin-access.coordinator.js';
import { MemoryAdminAuthRepository } from '../src/adapters/memory-admin-auth.repository.js';
import { MemoryAdminLoginThrottle } from '../src/adapters/memory-admin-login-throttle.js';
import { MemoryIamAdministrationRepository } from '../src/adapters/memory-iam-administration.repository.js';
import { OtplibTotpProvider } from '../src/adapters/otplib-totp.provider.js';
import { AdminAuthService } from '../src/application/admin-auth.service.js';
import type { PasswordHasher } from '../src/ports/password-hasher.js';

const ADMIN_ID = '0198fabc-1234-7abc-8abc-000000000001';
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,p=1,t=3$ZHVtbXlzYWx0MTIzNDU2Nw$ZHVtbXlkaWdlc3QxMjM0NTY3ODkwMTIzNDU2Nzg5MDE';

class FakePasswordHasher implements PasswordHasher {
  readonly attempts: string[] = [];
  readonly passwordAttempts: string[] = [];
  isPolicyDigest(digest: string) {
    return /^\$argon2id\$v=19\$m=65536,p=1,t=3\$/.test(digest);
  }
  hash(password: string): Promise<string> {
    return Promise.resolve(`hash:${password}`);
  }
  verify(digest: string, password: string) {
    this.attempts.push(digest);
    this.passwordAttempts.push(password);
    return Promise.resolve({
      valid: digest === 'hash:correct-password' && password === 'correct-password',
      needsRehash: false,
    });
  }
}

function fixture(
  options: {
    issuer?: {
      issue(input: { adminId: string; sessionId: string; issuedAt: Date }): Promise<string>;
    };
    pepperKeyring?: {
      current: { version: string; key: Uint8Array };
      previous?: readonly { version: string; key: Uint8Array }[];
    };
    throttle?: MemoryAdminLoginThrottle;
    cleanupObserver?: {
      recordCleanupFailure(event: {
        operation: 'MFA_SESSION_RELEASE' | 'REFRESH_SESSION_RELEASE';
        code: 'ADMIN_AUTH_CLEANUP_FAILED';
      }): void | Promise<void>;
    };
  } = {},
) {
  let nowMs = Date.UTC(2026, 8, 1, 8, 0, 0);
  let randomSequence = 0;
  let uuidSequence = 10;
  const coordinator = new MemoryAdminAccessCoordinator();
  new MemoryIamAdministrationRepository({
    admins: [{ id: ADMIN_ID, email: 'ops@example.com', status: 'ACTIVE' }],
  }, coordinator);
  const repository = new MemoryAdminAuthRepository(
    [{
      id: ADMIN_ID,
      email: 'ops@example.com',
      passwordHash: 'hash:correct-password',
      status: 'ACTIVE',
      mfaEnabled: false,
      pendingTotpSecretCiphertext: null,
      totpSecretCiphertext: null,
      lastTotpTimeStep: null,
      recoveryGeneration: null,
      mfaFailureCount: 0,
      mfaFailureWindowStartedAt: null,
      mfaLockedUntil: null,
    }],
    coordinator,
  );
  const passwordHasher = new FakePasswordHasher();
  const service = new AdminAuthService({
    repository,
    passwordHasher,
    dummyPasswordHash: DUMMY_HASH,
    secretCipher: new LocalAesGcmSecretCipher(Buffer.alloc(32, 7)),
    totpProvider: new OtplibTotpProvider(),
    accessTokenIssuer: options.issuer ?? {
      issue: ({ adminId, sessionId }) => Promise.resolve(`jwt:${adminId}:${sessionId}`),
    },
    loginThrottle: options.throttle ?? {
      reserve: (subject) => Promise.resolve({ subject, token: 'test-permit' }),
      commitFailure: () => Promise.resolve(),
      commitSuccess: () => Promise.resolve(),
      release: () => Promise.resolve(),
    },
    cleanupObserver: options.cleanupObserver ?? { recordCleanupFailure: () => {} },
    ...(options.pepperKeyring
      ? { recoveryCodePepperKeyring: options.pepperKeyring }
      : { recoveryCodePepper: Buffer.alloc(32, 9) }),
    now: () => new Date(nowMs),
    randomBytes: () => Buffer.alloc(32, ++randomSequence),
    uuidV7: () => `0198fabc-1234-7abc-8abc-${String(++uuidSequence).padStart(12, '0')}`,
  });
  return {
    repository,
    service,
    passwordHasher,
    now: () => new Date(nowMs),
    advance: (milliseconds: number) => {
      nowMs += milliseconds;
    },
  };
}

async function enroll(f: ReturnType<typeof fixture>) {
  const enrollment = await f.service.startMfaEnrollment(ADMIN_ID);
  const token = await generate({ secret: enrollment.secret, epoch: f.now().getTime() / 1_000 });
  const recoveryCodes = await f.service.confirmMfaEnrollment(ADMIN_ID, token);
  f.advance(30_000);
  return { secret: enrollment.secret, recoveryCodes };
}

async function currentTotp(secret: string, f: ReturnType<typeof fixture>) {
  return generate({ secret, epoch: f.now().getTime() / 1_000 });
}

describe('AdminAuthService', () => {
  it('does not enable MFA or issue an administrator session before enrollment confirmation', async () => {
    const f = fixture();
    await f.service.startMfaEnrollment(ADMIN_ID);
    await expect(
      f.service.verifyPassword('ops@example.com', 'correct-password'),
    ).rejects.toMatchObject({
      code: 'MFA_NOT_ENROLLED',
    });
    expect((await f.repository.findAdminById(ADMIN_ID))?.mfaEnabled).toBe(false);
  });

  it('requires password then a valid one-time TOTP challenge before issuing a session', async () => {
    const f = fixture();
    const { secret } = await enroll(f);
    const passwordStep = await f.service.verifyPassword('OPS@example.com', 'correct-password');
    expect(passwordStep.challengeId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(passwordStep).not.toHaveProperty('accessToken');

    await expect(
      f.service.verifyTotp(passwordStep.challengeId, '000000', 'Chrome'),
    ).rejects.toMatchObject({
      code: 'INVALID_MFA',
    });
    const authenticated = await f.service.verifyTotp(
      passwordStep.challengeId,
      await currentTotp(secret, f),
      'Chrome',
    );
    expect(authenticated.accessToken).toContain(`jwt:${ADMIN_ID}:`);
    expect(authenticated.refreshToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.stringify(f.repository)).not.toContain(authenticated.refreshToken);
  });

  it('does not reveal whether an administrator email exists', async () => {
    const f = fixture();
    await expect(
      f.service.verifyPassword('ops@example.com', 'wrong-password'),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(
      f.service.verifyPassword('missing@example.com', 'wrong-password'),
    ).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(f.passwordHasher.attempts).toEqual(['hash:correct-password', DUMMY_HASH]);
  });

  it('admits only five Argon verifications during a 20-request concurrent password attack', async () => {
    const throttle = new MemoryAdminLoginThrottle({ maxFailures: 5 });
    const f = fixture({ throttle });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 20 }, () =>
        f.service.verifyPassword('ops@example.com', 'wrong-password'),
      ),
    );
    expect(f.passwordHasher.attempts).toHaveLength(5);
    expect(outcomes.filter((result) => result.status === 'rejected')).toHaveLength(20);
  });

  it('caps oversized password work identically for existing and missing administrators', async () => {
    const f = fixture();
    const oversized = 'x'.repeat(1_025_000);
    await expect(f.service.verifyPassword('ops@example.com', oversized)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    await expect(f.service.verifyPassword('missing@example.com', oversized)).rejects.toMatchObject({
      code: 'INVALID_CREDENTIALS',
    });
    expect(f.passwordHasher.attempts).toEqual(['hash:correct-password', DUMMY_HASH]);
    expect(f.passwordHasher.passwordAttempts.every((password) => password.length <= 1_024)).toBe(
      true,
    );
  });

  it('rejects re-enrollment after MFA is enabled so an active secret cannot be silently replaced', async () => {
    const f = fixture();
    await enroll(f);
    await expect(f.service.startMfaEnrollment(ADMIN_ID)).rejects.toMatchObject({
      code: 'MFA_ALREADY_ENABLED',
    });
  });

  it('expires, consumes and locks MFA challenges with stable errors', async () => {
    const expired = fixture();
    const { secret: expiredSecret } = await enroll(expired);
    const expiredChallenge = await expired.service.verifyPassword(
      'ops@example.com',
      'correct-password',
    );
    expired.advance(5 * 60_000);
    await expect(
      expired.service.verifyTotp(
        expiredChallenge.challengeId,
        await currentTotp(expiredSecret, expired),
        'Chrome',
      ),
    ).rejects.toMatchObject({ code: 'MFA_CHALLENGE_EXPIRED' });

    const replayed = fixture();
    const { secret: replaySecret } = await enroll(replayed);
    const replayChallenge = await replayed.service.verifyPassword(
      'ops@example.com',
      'correct-password',
    );
    const valid = await currentTotp(replaySecret, replayed);
    await replayed.service.verifyTotp(replayChallenge.challengeId, valid, 'Chrome');
    await expect(
      replayed.service.verifyTotp(replayChallenge.challengeId, valid, 'Chrome'),
    ).rejects.toMatchObject({
      code: 'MFA_CHALLENGE_USED',
    });

    const locked = fixture();
    await enroll(locked);
    const lockedChallenge = await locked.service.verifyPassword(
      'ops@example.com',
      'correct-password',
    );
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        locked.service.verifyTotp(lockedChallenge.challengeId, '000000', 'Chrome'),
      ).rejects.toMatchObject({
        code: 'INVALID_MFA',
      });
    }
    await expect(
      locked.service.verifyTotp(lockedChallenge.challengeId, '000000', 'Chrome'),
    ).rejects.toMatchObject({
      code: 'MFA_CHALLENGE_LOCKED',
    });
  });

  it('shares the MFA failure window across challenges and clears it only after MFA succeeds', async () => {
    const f = fixture();
    const { secret } = await enroll(f);
    const first = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const second = await f.service.verifyPassword('ops@example.com', 'correct-password');

    for (const challenge of [first, first, first, second, second]) {
      await expect(
        f.service.verifyTotp(challenge.challengeId, '000000', 'Chrome'),
      ).rejects.toMatchObject({ code: 'INVALID_MFA' });
    }
    await expect(
      f.service.verifyPassword('ops@example.com', 'correct-password'),
    ).rejects.toMatchObject({ code: 'MFA_CHALLENGE_LOCKED' });
    await expect(f.service.verifyTotp(first.challengeId, '000000', 'Chrome')).rejects.toMatchObject(
      { code: 'MFA_CHALLENGE_LOCKED' },
    );

    f.advance(15 * 60_000 + 1);
    const afterLock = await f.service.verifyPassword('ops@example.com', 'correct-password');
    await f.service.verifyTotp(afterLock.challengeId, await currentTotp(secret, f), 'Chrome');
    f.advance(30_000);
    const afterSuccess = await f.service.verifyPassword('ops@example.com', 'correct-password');
    await expect(
      f.service.verifyTotp(afterSuccess.challengeId, '000000', 'Chrome'),
    ).rejects.toMatchObject({ code: 'INVALID_MFA' });
    await expect(
      f.service.verifyPassword('ops@example.com', 'correct-password'),
    ).resolves.toHaveProperty('challengeId');
  });

  it('counts well-formed but invalid recovery codes in the shared MFA budget', async () => {
    const f = fixture();
    await enroll(f);
    const first = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const second = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const invalidRecoveryCode = '00000000-00000000-00000000-00000000';
    for (const challenge of [first, second, first, second, first]) {
      await expect(
        f.service.verifyRecoveryCode(challenge.challengeId, invalidRecoveryCode, 'Chrome'),
      ).rejects.toMatchObject({ code: 'INVALID_MFA' });
    }
    await expect(
      f.service.verifyPassword('ops@example.com', 'correct-password'),
    ).rejects.toMatchObject({ code: 'MFA_CHALLENGE_LOCKED' });
  });

  it('rejects reuse of a TOTP time-step across different login challenges', async () => {
    const f = fixture();
    const { secret } = await enroll(f);
    const token = await currentTotp(secret, f);
    const first = await f.service.verifyPassword('ops@example.com', 'correct-password');
    await f.service.verifyTotp(first.challengeId, token, 'Chrome');
    const second = await f.service.verifyPassword('ops@example.com', 'correct-password');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(
        f.service.verifyTotp(second.challengeId, token, 'Firefox'),
      ).rejects.toMatchObject({
        code: 'MFA_REPLAY_DETECTED',
      });
    }
    await expect(
      f.service.verifyPassword('ops@example.com', 'correct-password'),
    ).rejects.toMatchObject({ code: 'MFA_CHALLENGE_LOCKED' });
  });

  it('stores recovery codes only as keyed digests and consumes one exactly once under concurrency', async () => {
    const f = fixture();
    const { recoveryCodes } = await enroll(f);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(JSON.stringify(f.repository)).not.toContain(recoveryCodes[0]);
    const first = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const second = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const settled = await Promise.allSettled([
      f.service.verifyRecoveryCode(first.challengeId, requiredCode(recoveryCodes, 0), 'Chrome'),
      f.service.verifyRecoveryCode(second.challengeId, requiredCode(recoveryCodes, 0), 'Firefox'),
    ]);
    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(settled.filter((result) => result.status === 'rejected')).toHaveLength(1);
  });

  it('regenerating recovery codes atomically invalidates every prior code', async () => {
    const f = fixture();
    const { secret, recoveryCodes: oldCodes } = await enroll(f);
    const newCodes = await f.service.regenerateRecoveryCodes(
      ADMIN_ID,
      await currentTotp(secret, f),
    );
    f.advance(30_000);
    const oldChallenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    await expect(
      f.service.verifyRecoveryCode(oldChallenge.challengeId, requiredCode(oldCodes, 0), 'Chrome'),
    ).rejects.toMatchObject({
      code: 'INVALID_MFA',
    });
    const newChallenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    await expect(
      f.service.verifyRecoveryCode(newChallenge.challengeId, requiredCode(newCodes, 0), 'Chrome'),
    ).resolves.toHaveProperty('accessToken');
  });

  it('rotates digest-only admin refresh tokens and revokes the family on reuse', async () => {
    const f = fixture();
    const { recoveryCodes } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const first = await f.service.verifyRecoveryCode(
      challenge.challengeId,
      requiredCode(recoveryCodes, 0),
      'Chrome',
    );
    const rotated = await f.service.rotateRefresh(first.refreshToken);
    await expect(f.service.rotateRefresh(first.refreshToken)).rejects.toMatchObject({
      code: 'REFRESH_REUSE_DETECTED',
    });
    await expect(f.service.rotateRefresh(rotated.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
  });
  it('does not call signer for invalid factors and releases the recovery reservation after KMS failure', async () => {
    const issue = vi
      .fn()
      .mockRejectedValueOnce(new Error('kms unavailable'))
      .mockResolvedValueOnce('jwt');
    const f = fixture({ issuer: { issue } });
    const release = vi.spyOn(f.repository, 'releaseMfaSession');
    const { recoveryCodes } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    await expect(
      f.service.verifyRecoveryCode(
        challenge.challengeId,
        '00000000-00000000-00000000-00000000',
        'Chrome',
      ),
    ).rejects.toMatchObject({ code: 'INVALID_MFA' });
    expect(issue).not.toHaveBeenCalled();
    await expect(
      f.service.verifyRecoveryCode(challenge.challengeId, requiredCode(recoveryCodes, 0), 'Chrome'),
    ).rejects.toMatchObject({ code: 'ADMIN_TOKEN_ISSUANCE_FAILED' });
    expect(issue).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    await expect(
      f.service.verifyRecoveryCode(challenge.challengeId, requiredCode(recoveryCodes, 0), 'Chrome'),
    ).resolves.toHaveProperty('accessToken', 'jwt');
  });

  it('revokes the refresh family when successor JWT signing fails', async () => {
    const issue = vi
      .fn()
      .mockResolvedValueOnce('jwt')
      .mockRejectedValueOnce(new Error('kms unavailable'))
      .mockResolvedValueOnce('jwt-retry');
    const f = fixture({ issuer: { issue } });
    const release = vi.spyOn(f.repository, 'releaseRotatedSession');
    const { secret } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const session = await f.service.verifyTotp(
      challenge.challengeId,
      await currentTotp(secret, f),
      'Chrome',
    );
    await expect(f.service.rotateRefresh(session.refreshToken)).rejects.toMatchObject({
      code: 'ADMIN_TOKEN_ISSUANCE_FAILED',
    });
    expect(release).toHaveBeenCalledOnce();
    await expect(f.service.rotateRefresh(session.refreshToken)).resolves.toHaveProperty(
      'accessToken',
      'jwt-retry',
    );
  });

  it('uses a fresh post-signing time and releases an MFA reservation that expires while signing', async () => {
    let advanceDuringSigning = () => {};
    const issue = vi.fn(() => {
      advanceDuringSigning();
      return Promise.resolve('jwt');
    });
    const f = fixture({ issuer: { issue } });
    let firstSigning = true;
    advanceDuringSigning = () => {
      if (!firstSigning) return;
      firstSigning = false;
      f.advance(5 * 60_000 + 1);
    };
    const finalize = vi.spyOn(f.repository, 'finalizeMfaSession');
    const { recoveryCodes } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');

    await expect(
      f.service.verifyRecoveryCode(challenge.challengeId, requiredCode(recoveryCodes, 0), 'Chrome'),
    ).rejects.toMatchObject({ code: 'ADMIN_TOKEN_ISSUANCE_FAILED' });
    expect(finalize.mock.calls[0]?.[0].now).toEqual(f.now());

    const retryChallenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    await expect(
      f.service.verifyRecoveryCode(
        retryChallenge.challengeId,
        requiredCode(recoveryCodes, 0),
        'Chrome',
      ),
    ).resolves.toHaveProperty('accessToken', 'jwt');
  });

  it('does not activate an MFA session when the administrator is disabled during signing', async () => {
    let disableDuringSigning = () => {};
    const f = fixture({
      issuer: {
        issue: () => {
          disableDuringSigning();
          return Promise.resolve('jwt');
        },
      },
    });
    disableDuringSigning = () => {
      const repositoryState = f.repository as unknown as {
        admins: Map<string, { status: 'ACTIVE' | 'DISABLED' }>;
      };
      const admin = repositoryState.admins.get(ADMIN_ID);
      if (!admin) throw new Error('EXPECTED_ADMIN');
      admin.status = 'DISABLED';
    };
    const { recoveryCodes } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');

    await expect(
      f.service.verifyRecoveryCode(challenge.challengeId, requiredCode(recoveryCodes, 0), 'Chrome'),
    ).rejects.toMatchObject({ code: 'ADMIN_TOKEN_ISSUANCE_FAILED' });
  });

  it('does not activate a refresh successor after its family is revoked during signing', async () => {
    let revokeDuringSigning = () => Promise.resolve();
    const f = fixture({ issuer: { issue: async () => (await revokeDuringSigning(), 'jwt') } });
    const { recoveryCodes } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const active = await f.service.verifyRecoveryCode(
      challenge.challengeId,
      requiredCode(recoveryCodes, 0),
      'Chrome',
    );
    revokeDuringSigning = () =>
      f.repository.revokeSessionFamily(active.session.adminId, active.session.familyId, f.now()).then(
        () => undefined,
      );

    await expect(f.service.rotateRefresh(active.refreshToken)).rejects.toMatchObject({
      code: 'ADMIN_TOKEN_ISSUANCE_FAILED',
    });
  });

  it('never accepts a PENDING unsigned MFA session as a refresh session', async () => {
    let rejectSigning: (reason?: unknown) => void = () => {};
    const issue = vi.fn(
      () =>
        new Promise<string>((_resolve, reject) => {
          rejectSigning = reject;
        }),
    );
    const f = fixture({ issuer: { issue } });
    const completion = vi.spyOn(f.repository, 'completeRecoveryChallenge');
    const { recoveryCodes } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const attempt = f.service.verifyRecoveryCode(
      challenge.challengeId,
      requiredCode(recoveryCodes, 0),
      'Chrome',
    );
    const rejection = expect(attempt).rejects.toMatchObject({
      code: 'ADMIN_TOKEN_ISSUANCE_FAILED',
    });
    while (issue.mock.calls.length === 0) await Promise.resolve();
    const input = completion.mock.calls[0]?.[0];
    if (!input) throw new Error('EXPECTED_PENDING_INPUT');
    await expect(
      f.repository.rotateSession({
        presentedDigest: input.session.refreshTokenDigest,
        now: f.now(),
        successor: {
          id: '0198fabc-1234-7abc-8abc-000000000901',
          refreshTokenDigest: '9'.repeat(64),
          createdAt: f.now(),
          expiresAt: new Date(f.now().getTime() + 60_000),
        },
      }),
    ).resolves.toEqual({ kind: 'invalid' });
    rejectSigning(new Error('kms unavailable'));
    await rejection;
  });

  it('keeps a stable signing error and an unusable PENDING session when compensation fails', async () => {
    const recordCleanupFailure = vi.fn();
    const f = fixture({
      issuer: { issue: () => Promise.reject(new Error('kms unavailable')) },
      cleanupObserver: { recordCleanupFailure },
    });
    vi.spyOn(f.repository, 'releaseMfaSession').mockRejectedValue(
      new Error('database unavailable'),
    );
    const completion = vi.spyOn(f.repository, 'completeRecoveryChallenge');
    const { recoveryCodes } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    await expect(
      f.service.verifyRecoveryCode(challenge.challengeId, requiredCode(recoveryCodes, 0), 'Chrome'),
    ).rejects.toMatchObject({ code: 'ADMIN_TOKEN_ISSUANCE_FAILED' });
    const input = completion.mock.calls[0]?.[0];
    if (!input) throw new Error('EXPECTED_PENDING_INPUT');
    await expect(
      f.repository.rotateSession({
        presentedDigest: input.session.refreshTokenDigest,
        now: f.now(),
        successor: {
          id: '0198fabc-1234-7abc-8abc-000000000902',
          refreshTokenDigest: '8'.repeat(64),
          createdAt: f.now(),
          expiresAt: new Date(f.now().getTime() + 60_000),
        },
      }),
    ).resolves.toEqual({ kind: 'invalid' });
    expect(recordCleanupFailure).toHaveBeenCalledWith({
      operation: 'MFA_SESSION_RELEASE',
      code: 'ADMIN_AUTH_CLEANUP_FAILED',
    });
    f.advance(2 * 60_000 + 1);
    await expect(f.repository.cleanupExpiredPendingSessions(f.now(), 10)).resolves.toBe(1);
  });

  it('atomically disables administrator access and revokes every existing session', async () => {
    const f = fixture();
    const { recoveryCodes } = await enroll(f);
    const challenge = await f.service.verifyPassword('ops@example.com', 'correct-password');
    const active = await f.service.verifyRecoveryCode(
      challenge.challengeId,
      requiredCode(recoveryCodes, 0),
      'Chrome',
    );

    await expect(f.service.disableAdminAccess(ADMIN_ID)).resolves.toBe('disabled');
    await expect(f.service.rotateRefresh(active.refreshToken)).rejects.toMatchObject({
      code: 'SESSION_REVOKED',
    });
    await expect(f.repository.findAdminById(ADMIN_ID)).resolves.toMatchObject({
      status: 'DISABLED',
    });
  });

  it('refuses to disable the last active protected administrator', async () => {
    const f = fixture();
    const detached = new MemoryAdminAuthRepository([
      await requiredAdmin(f.repository.findAdminById(ADMIN_ID)),
    ]);
    await expect(detached.disableAdminAccess(ADMIN_ID, f.now())).rejects.toMatchObject({
      code: 'ADMIN_DISABLE_COORDINATOR_UNAVAILABLE',
    });
    const coordinator = new MemoryAdminAccessCoordinator();
    const management = new MemoryIamAdministrationRepository({
      admins: [{ id: ADMIN_ID, email: 'ops@example.com', status: 'ACTIVE' }],
    }, coordinator);
    const bootstrap = await management.bootstrapSuperAdmin({
      adminId: ADMIN_ID,
      roleId: '0198fabc-1234-7abc-8abc-000000000099',
      audit: {
        id: '0198fabc-1234-7abc-8abc-000000000098',
        action: 'super-admin.bootstrap',
        resourceType: 'admin',
        resourceId: ADMIN_ID,
        outcome: 'SUCCESS',
        context: {
          actorId: null,
          ipAddress: '127.0.0.1',
          userAgent: 'admin-auth-test',
          traceId: 'a'.repeat(32),
          correlationId: '0198fabc-1234-7abc-8abc-000000000097',
          occurredAt: f.now(),
        },
      },
    });
    expect(bootstrap.kind).toBe('created');
    const repository = new MemoryAdminAuthRepository(
      [await requiredAdmin(f.repository.findAdminById(ADMIN_ID))],
      coordinator,
    );
    const service = new AdminAuthService({
      repository,
      passwordHasher: f.passwordHasher,
      dummyPasswordHash: DUMMY_HASH,
      secretCipher: new LocalAesGcmSecretCipher(Buffer.alloc(32, 7)),
      totpProvider: new OtplibTotpProvider(),
      accessTokenIssuer: { issue: () => Promise.resolve('jwt') },
      loginThrottle: {
        reserve: (subject) => Promise.resolve({ subject, token: 'permit' }),
        commitFailure: () => Promise.resolve(),
        commitSuccess: () => Promise.resolve(),
        release: () => Promise.resolve(),
      },
      cleanupObserver: { recordCleanupFailure: () => {} },
      recoveryCodePepperKeyring: {
        current: { version: 'v1', key: Buffer.alloc(32, 3) },
      },
    });

    await expect(service.disableAdminAccess(ADMIN_ID)).rejects.toMatchObject({
      code: 'LAST_SUPER_ADMIN_PROTECTED',
    });
    await expect(repository.findAdminById(ADMIN_ID)).resolves.toMatchObject({ status: 'ACTIVE' });
  });

  it('accepts retained recovery pepper versions while new generations use current and invalidate old codes', async () => {
    const old = fixture({
      pepperKeyring: { current: { version: 'v1', key: Buffer.alloc(32, 1) } },
    });
    const enrolled = await enroll(old);
    const admin = await old.repository.findAdminById(ADMIN_ID);
    if (!admin) throw new Error('EXPECTED_ADMIN');
    const rotatedService = new AdminAuthService({
      repository: old.repository,
      passwordHasher: old.passwordHasher,
      dummyPasswordHash: DUMMY_HASH,
      secretCipher: new LocalAesGcmSecretCipher(Buffer.alloc(32, 7)),
      totpProvider: new OtplibTotpProvider(),
      accessTokenIssuer: { issue: () => Promise.resolve('jwt') },
      loginThrottle: {
        reserve: (subject) => Promise.resolve({ subject, token: 'p' }),
        commitFailure: () => Promise.resolve(),
        commitSuccess: () => Promise.resolve(),
        release: () => Promise.resolve(),
      },
      cleanupObserver: { recordCleanupFailure: () => {} },
      recoveryCodePepperKeyring: {
        current: { version: 'v2', key: Buffer.alloc(32, 2) },
        previous: [{ version: 'v1', key: Buffer.alloc(32, 1) }],
      },
      now: old.now,
      randomBytes: () => Buffer.alloc(32, 5),
      uuidV7: (() => {
        let n = 500;
        return () => `0198fabc-1234-7abc-8abc-${String(++n).padStart(12, '0')}`;
      })(),
    });
    const challenge = await rotatedService.verifyPassword('ops@example.com', 'correct-password');
    await expect(
      rotatedService.verifyRecoveryCode(
        challenge.challengeId,
        requiredCode(enrolled.recoveryCodes, 0),
        'Chrome',
      ),
    ).resolves.toHaveProperty('accessToken');
  });

  it('snapshots hostile recovery pepper accessors exactly once', () => {
    let versionReads = 0;
    let keyReads = 0;
    const entry = Object.defineProperties(
      {},
      {
        version: { get: () => (++versionReads === 1 ? 'v1' : '../../evil') },
        key: {
          get: () => {
            keyReads += 1;
            return keyReads === 1 ? Buffer.alloc(32, 4) : Buffer.alloc(1);
          },
        },
      },
    );
    expect(() =>
      fixture({ pepperKeyring: { current: entry as { version: string; key: Uint8Array } } }),
    ).not.toThrow();
    expect({ versionReads, keyReads }).toEqual({ versionReads: 1, keyReads: 1 });
  });
});

function requiredCode(codes: readonly string[], index: number): string {
  const code = codes[index];
  if (!code) throw new Error('EXPECTED_RECOVERY_CODE');
  return code;
}

async function requiredAdmin<T>(value: Promise<T | null>): Promise<T> {
  const record = await value;
  if (!record) throw new Error('EXPECTED_ADMIN');
  return record;
}
