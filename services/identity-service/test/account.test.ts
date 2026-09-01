import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  IdentityAccountService,
  type AccountMutationRepository,
  type AccountMutationTransaction,
  type OutboxWrite,
} from '../src/application/identity-account.service.js';
import type { SmsChallengeVerifier } from '../src/ports/sms-challenge-verifier.js';
import { EventMetadata } from '../src/domain/event-metadata.js';

const operationFingerprintHasher = {
  hash: (domain: string, rawIdentifier: string) =>
    Promise.resolve(testFingerprint(domain, rawIdentifier)),
  hashCurrent: (domain: string, rawIdentifier: string) =>
    Promise.resolve({
      digest: testFingerprint(domain, rawIdentifier),
      keyVersion: 'test-v1',
    }),
  hashCandidates: (domain: string, rawIdentifier: string) =>
    Promise.resolve([
      { digest: testFingerprint(domain, rawIdentifier), keyVersion: 'test-v1' },
    ]),
};

function testFingerprint(domain: string, rawIdentifier: string): string {
  return createHmac('sha256', Buffer.alloc(32, 7))
    .update(domain)
    .update('\0')
    .update(rawIdentifier)
    .digest('hex');
}

function versionedTestHasher(
  current: { readonly version: string; readonly keyByte: number },
  previous: ReadonlyArray<{ readonly version: string; readonly keyByte: number }> = [],
) {
  const digest = (keyByte: number, domain: string, rawIdentifier: string) =>
    createHmac('sha256', Buffer.alloc(32, keyByte))
      .update(domain)
      .update('\0')
      .update(rawIdentifier)
      .digest('hex');
  const candidate = (
    key: { readonly version: string; readonly keyByte: number },
    domain: string,
    rawIdentifier: string,
  ) => ({ digest: digest(key.keyByte, domain, rawIdentifier), keyVersion: key.version });
  return {
    hash: (domain: string, rawIdentifier: string) =>
      Promise.resolve(digest(current.keyByte, domain, rawIdentifier)),
    hashCurrent: (domain: string, rawIdentifier: string) =>
      Promise.resolve(candidate(current, domain, rawIdentifier)),
    hashCandidates: (domain: string, rawIdentifier: string) =>
      Promise.resolve(
        [current, ...previous].map((key) => candidate(key, domain, rawIdentifier)),
      ),
  };
}

interface UserState {
  id: string;
  phoneE164: string;
  nickname: string;
  status: string;
}

class MemoryAccountRepository implements AccountMutationRepository {
  readonly users = new Map<string, UserState>();
  readonly events: OutboxWrite[] = [];
  revokedUsers: string[] = [];
  createdUsers = 0;
  frozenWrites: boolean[] = [];
  simulateSerializationRetryOnce = false;
  maxActiveTransactions = 0;
  private activeTransactions = 0;
  private readonly operationTails = new Map<string, Promise<void>>();

  constructor() {
    this.users.set('u1', {
      id: 'u1',
      phoneE164: '+8613800138000',
      nickname: 'before',
      status: 'ACTIVE',
    });
  }

  async transaction<T>(
    scope: { readonly userId: string; readonly operationId?: string } | null,
    work: (transaction: AccountMutationTransaction) => Promise<T>,
  ): Promise<T> {
    let release: (() => void) | undefined;
    let tail: Promise<void> | undefined;
    const accountLock = typeof scope === 'object' && scope ? `account:${scope.userId}` : undefined;
    if (accountLock) {
      const previous = this.operationTails.get(accountLock) ?? Promise.resolve();
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      tail = previous.then(() => gate);
      this.operationTails.set(accountLock, tail);
      await previous;
    }
    const usersSnapshot = structuredClone([...this.users.entries()]);
    const eventsLength = this.events.length;
    const revokedLength = this.revokedUsers.length;
    const restore = () => {
      this.users.clear();
      for (const [id, user] of usersSnapshot) this.users.set(id, structuredClone(user));
      this.events.length = eventsLength;
      this.revokedUsers.length = revokedLength;
    };
    try {
      this.activeTransactions += 1;
      this.maxActiveTransactions = Math.max(this.maxActiveTransactions, this.activeTransactions);
      const result = await work(this);
      if (this.simulateSerializationRetryOnce) {
        this.simulateSerializationRetryOnce = false;
        restore();
        return await work(this);
      }
      return result;
    } catch (error: unknown) {
      restore();
      throw error;
    } finally {
      this.activeTransactions -= 1;
      release?.();
      if (accountLock && this.operationTails.get(accountLock) === tail) {
        this.operationTails.delete(accountLock);
      }
    }
  }

  getActiveUser(userId: string): Promise<UserState | null> {
    const user = this.users.get(userId);
    return Promise.resolve(user?.status === 'ACTIVE' ? structuredClone(user) : null);
  }

  getActiveUserByPhone(phoneE164: string): Promise<UserState | null> {
    const user = [...this.users.values()].find(
      (candidate) => candidate.phoneE164 === phoneE164 && candidate.status === 'ACTIVE',
    );
    return Promise.resolve(user ? structuredClone(user) : null);
  }

  findOrCreateActiveUserByPhone(
    phoneE164: string,
    create: { id: string; nickname: string },
  ): Promise<UserState> {
    const existing = [...this.users.values()].find((user) => user.phoneE164 === phoneE164);
    if (existing) return Promise.resolve(structuredClone(existing));
    const user = { ...create, phoneE164, status: 'ACTIVE' };
    this.users.set(user.id, user);
    this.createdUsers += 1;
    return Promise.resolve(structuredClone(user));
  }

  isPhoneAvailable(phoneE164: string, excludingUserId: string): Promise<boolean> {
    return Promise.resolve(
      ![...this.users.values()].some(
        (user) => user.id !== excludingUserId && user.phoneE164 === phoneE164,
      ),
    );
  }

  updatePhone(userId: string, phoneE164: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('missing');
    user.phoneE164 = phoneE164;
    return Promise.resolve();
  }

  updateNickname(userId: string, nickname: string): Promise<void> {
    const user = this.users.get(userId);
    if (!user) throw new Error('missing');
    user.nickname = nickname;
    return Promise.resolve();
  }

  closeUser(userId: string): Promise<boolean> {
    const user = this.users.get(userId);
    if (!user || user.status === 'CLOSED') return Promise.resolve(false);
    user.status = 'CLOSED';
    return Promise.resolve(true);
  }

  revokeAllSessions(userId: string, now: Date): Promise<void> {
    void now;
    this.revokedUsers.push(userId);
    return Promise.resolve();
  }

  getOperationResult(expectation: {
    dedupeKey: string;
    aggregateId: string;
    type: OutboxWrite['type'];
    requestFingerprints: ReadonlyArray<{ digest: string; keyVersion: string }>;
  }): Promise<'missing' | 'completed'> {
    const existing = this.events.find((event) => event.dedupeKey === expectation.dedupeKey);
    if (!existing) return Promise.resolve('missing');
    if (
      existing.aggregateId === expectation.aggregateId &&
      existing.type === expectation.type &&
      expectation.requestFingerprints.some(
        ({ digest, keyVersion }) =>
          existing.data.requestFingerprint === digest &&
          existing.data.requestFingerprintKeyVersion === keyVersion,
      )
    ) {
      return Promise.resolve('completed');
    }
    return Promise.reject(
      Object.assign(new Error('IDEMPOTENCY_KEY_REUSED'), { code: 'IDEMPOTENCY_KEY_REUSED' }),
    );
  }

  appendOutbox(event: OutboxWrite) {
    this.frozenWrites.push(Object.isFrozen(event) && Object.isFrozen(event.data));
    if (!this.events.some((existing) => existing.dedupeKey === event.dedupeKey)) {
      this.events.push(structuredClone(event));
    }
    return Promise.resolve();
  }
}

class CodeVerifier implements SmsChallengeVerifier {
  readonly calls: Array<{ phoneE164: string; code: string }> = [];
  constructor(private readonly accepted: Set<string>) {}
  verify(input: { phoneE164: string; code: string }): Promise<boolean> {
    this.calls.push(input);
    const key = `${input.phoneE164}:${input.code}`;
    const result = this.accepted.delete(key);
    return Promise.resolve(result);
  }
}

describe('IdentityAccountService', () => {
  it('logs in an existing user and transactionally registers a first-time phone', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111', '+8613900139000:222222']));
    let sequence = 0;
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
      uuidV7: () => `0198fabc-1234-7abc-8abc-${String(++sequence).padStart(12, '0')}`,
    });

    await expect(service.authenticatePhone('13800138000', '111111')).resolves.toMatchObject({
      id: 'u1',
    });
    const registered = await service.authenticatePhone('13900139000', '222222');
    expect(registered.id).toMatch(/-7[0-9a-f]{3}-[89ab]/);
    expect(registered.nickname).not.toContain('13900139000');
    expect(registered.nickname).not.toContain('+8613900139000');
    expect(repository.createdUsers).toBe(1);
  });

  it('converges concurrent first-time verification to one persisted user', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(new Set(['+8615800138000:111111', '+8615800138000:222222']));
    let sequence = 0;
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
      uuidV7: () => `0198fabc-1234-7abc-8abc-${String(++sequence).padStart(12, '0')}`,
    });

    const users = await Promise.all([
      service.authenticatePhone('15800138000', '111111'),
      service.authenticatePhone('15800138000', '222222'),
    ]);
    expect(users[0].id).toBe(users[1].id);
    expect(repository.createdUsers).toBe(1);
  });

  it('changes a phone only after consuming current and new phone challenges in one request', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111', '+8613900139000:222222']));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });

    await service.changePhone({
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '+8613900139000',
      newPhoneCode: '222222',
      operationId: '0198fabc-1234-7abc-8abc-333333333333',
      eventMetadata: EventMetadata.fromIngress({
        traceId: '0123456789abcdef0123456789abcdef',
        correlationId: '0198fabc-1234-7abc-8abc-999999999999',
      }),
    });

    expect(repository.users.get('u1')?.phoneE164).toBe('+8613900139000');
    expect(verifier.calls).toEqual([
      { phoneE164: '+8613800138000', code: '111111' },
      { phoneE164: '+8613900139000', code: '222222' },
    ]);
    expect(repository.events[0]?.id).toMatch(/-7[0-9a-f]{3}-[89ab]/);
    expect(repository.events).toEqual([
      expect.objectContaining({
        type: 'identity.user-phone-changed.v1',
        version: 1,
        aggregateId: 'u1',
        traceId: '0123456789abcdef0123456789abcdef',
        correlationId: '0198fabc-1234-7abc-8abc-999999999999',
        producer: 'identity-service',
        dedupeKey: 'phone-change:0198fabc-1234-7abc-8abc-333333333333',
      }),
    ]);
    expect(repository.events[0]?.data.userId).toBe('u1');
    expect(repository.events[0]?.data.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.events[0]?.data.requestFingerprintKeyVersion).toBe('test-v1');
    expect(repository.frozenWrites).toEqual([true]);
    expect(JSON.stringify(repository.events)).not.toContain('+8613800138000');
    expect(JSON.stringify(repository.events)).not.toContain('+8613900139000');
  });

  it('rejects either missing proof and prevents duplicate phone assignment', async () => {
    const repository = new MemoryAccountRepository();
    repository.users.set('u2', {
      id: 'u2',
      phoneE164: '+8613900139000',
      nickname: 'other',
      status: 'ACTIVE',
    });
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111']));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });

    await expect(
      service.changePhone({
        userId: 'u1',
        currentPhoneCode: '111111',
        newPhoneE164: '+8613900139000',
        newPhoneCode: '222222',
        operationId: '0198fabc-1234-7abc-8abc-333333333333',
        eventMetadata: EventMetadata.create(),
      }),
    ).rejects.toMatchObject({ code: 'SENSITIVE_OPERATION_REVERIFY_REQUIRED' });
    expect(repository.users.get('u1')?.phoneE164).toBe('+8613800138000');

    const duplicateVerifier = new CodeVerifier(
      new Set(['+8613800138000:111111', '+8613900139000:222222']),
    );
    const duplicateService = new IdentityAccountService({
      repository,
      smsVerifier: duplicateVerifier,
      operationFingerprintHasher,
    });
    await expect(
      duplicateService.changePhone({
        userId: 'u1',
        currentPhoneCode: '111111',
        newPhoneE164: '+8613900139000',
        newPhoneCode: '222222',
        operationId: '0198fabc-1234-7abc-8abc-444444444444',
        eventMetadata: EventMetadata.create(),
      }),
    ).rejects.toMatchObject({ code: 'PHONE_ALREADY_IN_USE' });
  });

  it('rejects an unchanged phone before consuming either OTP', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111']));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });

    await expect(
      service.changePhone({
        userId: 'u1',
        currentPhoneCode: '111111',
        newPhoneE164: '13800138000',
        newPhoneCode: '111111',
        operationId: '0198fabc-1234-7abc-8abc-454545454545',
        eventMetadata: EventMetadata.create(),
      }),
    ).rejects.toMatchObject({ code: 'PHONE_UNCHANGED' });
    expect(verifier.calls).toHaveLength(0);
  });

  it('waits for both phone proofs to settle before reporting an uncertain consumption result', async () => {
    const repository = new MemoryAccountRepository();
    let rejectCurrent!: (error: Error) => void;
    let resolveNew!: (verified: boolean) => void;
    const currentProof = new Promise<boolean>((_resolve, reject) => {
      rejectCurrent = reject;
    });
    const newProof = new Promise<boolean>((resolve) => {
      resolveNew = resolve;
    });
    const verifier: SmsChallengeVerifier = {
      verify: ({ phoneE164 }) =>
        phoneE164 === '+8613800138000' ? currentProof : newProof,
    };
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });
    const result = service.changePhone({
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '+8613900139000',
      newPhoneCode: '222222',
      operationId: '0198fabc-1234-7abc-8abc-464646464646',
      eventMetadata: EventMetadata.create(),
    });
    let settled = false;
    void result.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    await Promise.resolve();
    rejectCurrent(new Error('redis response lost'));
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    resolveNew(true);
    await expect(result).rejects.toMatchObject({
      code: 'SENSITIVE_OPERATION_REVERIFY_REQUIRED',
    });
  });

  it.each([
    ['true + error', true, new Error('new redis lost'), 'SENSITIVE_OPERATION_REVERIFY_REQUIRED'],
    ['error + true', new Error('current redis lost'), true, 'SENSITIVE_OPERATION_REVERIFY_REQUIRED'],
    ['true + false', true, false, 'SENSITIVE_OPERATION_REVERIFY_REQUIRED'],
    ['both errors', new Error('current lost'), new Error('new lost'), 'SENSITIVE_OPERATION_REVERIFY_REQUIRED'],
    ['both false', false, false, 'PHONE_VERIFICATION_FAILED'],
  ])('classifies dual proof outcome %s without leaking verifier failures', async (_case, current, next, code) => {
    const repository = new MemoryAccountRepository();
    const verifier: SmsChallengeVerifier = {
      verify: ({ phoneE164 }) => {
        const outcome = phoneE164 === '+8613800138000' ? current : next;
        return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
      },
    };
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });
    const failure = service.changePhone({
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '+8613900139000',
      newPhoneCode: '222222',
      operationId: '0198fabc-1234-7abc-8abc-474747474747',
      eventMetadata: EventMetadata.create(),
    });
    await expect(failure).rejects.toMatchObject({ code, message: code });
  });

  it('maps an uncertain close-account OTP verifier failure to stable re-verification', async () => {
    const repository = new MemoryAccountRepository();
    const service = new IdentityAccountService({
      repository,
      smsVerifier: { verify: () => Promise.reject(new Error('redis password detail')) },
      operationFingerprintHasher,
    });
    await expect(
      service.closeAccount({
        userId: 'u1',
        code: '111111',
        operationId: '0198fabc-1234-7abc-8abc-484848484848',
        eventMetadata: EventMetadata.create(),
      }),
    ).rejects.toMatchObject({
      code: 'SENSITIVE_OPERATION_REVERIFY_REQUIRED',
      message: 'SENSITIVE_OPERATION_REVERIFY_REQUIRED',
    });
    expect(repository.users.get('u1')?.status).toBe('ACTIVE');
  });

  it('atomically closes an account, revokes all sessions, and appends a PII-safe outbox event', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111']));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });

    await service.closeAccount({
      userId: 'u1',
      code: '111111',
      operationId: '0198fabc-1234-7abc-8abc-555555555555',
      eventMetadata: EventMetadata.create(),
    });

    expect(repository.users.get('u1')?.status).toBe('CLOSED');
    expect(repository.revokedUsers).toEqual(['u1']);
    expect(repository.events).toEqual([
      expect.objectContaining({
        type: 'identity.user-closed.v1',
        version: 1,
        aggregateId: 'u1',
        producer: 'identity-service',
        dedupeKey: 'account-close:0198fabc-1234-7abc-8abc-555555555555',
      }),
    ]);
    expect(repository.events[0]?.data.userId).toBe('u1');
    expect(repository.events[0]?.data.requestFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(repository.events[0]?.data.requestFingerprintKeyVersion).toBe('test-v1');
    await expect(
      service.closeAccount({
        userId: 'u1',
        code: '111111',
        operationId: '0198fabc-1234-7abc-8abc-555555555555',
        eventMetadata: EventMetadata.create(),
      }),
    ).resolves.toBeUndefined();
    expect(repository.events).toHaveLength(1);
  });

  it('rolls back account closure if the outbox write fails', async () => {
    const repository = new MemoryAccountRepository();
    repository.appendOutbox = () => Promise.reject(new Error('OUTBOX_DOWN'));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: new CodeVerifier(new Set(['+8613800138000:111111'])),
      operationFingerprintHasher,
    });

    await expect(
      service.closeAccount({
        userId: 'u1',
        code: '111111',
        operationId: '0198fabc-1234-7abc-8abc-666666666666',
        eventMetadata: EventMetadata.create(),
      }),
    ).rejects.toMatchObject({ code: 'SENSITIVE_OPERATION_REVERIFY_REQUIRED' });
    expect(repository.users.get('u1')?.status).toBe('ACTIVE');
    expect(repository.revokedUsers).toEqual([]);
  });

  it('maps a post-verification phone mutation failure without leaking proof or phone data', async () => {
    const repository = new MemoryAccountRepository();
    repository.appendOutbox = () => Promise.reject(new Error('db detail +8613900139000 222222'));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: new CodeVerifier(
        new Set(['+8613800138000:111111', '+8613900139000:222222']),
      ),
      operationFingerprintHasher,
    });

    const failure = service.changePhone({
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '+8613900139000',
      newPhoneCode: '222222',
      operationId: '0198fabc-1234-7abc-8abc-676767676767',
      eventMetadata: EventMetadata.create(),
    });

    await expect(failure).rejects.toMatchObject({
      code: 'SENSITIVE_OPERATION_REVERIFY_REQUIRED',
      message: 'SENSITIVE_OPERATION_REVERIFY_REQUIRED',
    });
  });

  it('returns a durable phone-change success on retry without consuming another OTP', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111', '+8613900139000:222222']));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });
    const input = {
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '+8613900139000',
      newPhoneCode: '222222',
      operationId: '0198fabc-1234-7abc-8abc-777777777777',
      eventMetadata: EventMetadata.create(),
    };

    await service.changePhone(input);
    await expect(service.changePhone(input)).resolves.toBeUndefined();
    expect(verifier.calls).toHaveLength(2);
    expect(
      repository.events.filter((event) => event.type === 'identity.user-phone-changed.v1'),
    ).toHaveLength(1);
  });

  it('matches a persisted fingerprint through the configured previous KMS key version', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111', '+8613900139000:222222']));
    const input = {
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '+8613900139000',
      newPhoneCode: '222222',
      operationId: '0198fabc-1234-7abc-8abc-787878787878',
      eventMetadata: EventMetadata.create(),
    };
    const beforeRotation = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher: versionedTestHasher({ version: 'v1', keyByte: 1 }),
    });
    await beforeRotation.changePhone(input);

    const duringRotation = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher: versionedTestHasher(
        { version: 'v2', keyByte: 2 },
        [{ version: 'v1', keyByte: 1 }],
      ),
    });
    await expect(duringRotation.changePhone(input)).resolves.toBeUndefined();
    expect(verifier.calls).toHaveLength(2);

    const withoutPrevious = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher: versionedTestHasher({ version: 'v2', keyByte: 2 }),
    });
    await expect(withoutPrevious.changePhone(input)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('rejects reuse of one operation id for a different normalized phone intent', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(
      new Set([
        '+8613800138000:111111',
        '+8613900139000:222222',
        '+8613700137000:333333',
      ]),
    );
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });
    const operationId = '0198fabc-1234-7abc-8abc-777777777777';

    await service.changePhone({
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '13900139000',
      newPhoneCode: '222222',
      operationId,
      eventMetadata: EventMetadata.create(),
    });
    await expect(
      service.changePhone({
        userId: 'u1',
        currentPhoneCode: 'unused',
        newPhoneE164: '+8613700137000',
        newPhoneCode: '333333',
        operationId,
        eventMetadata: EventMetadata.create(),
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(repository.users.get('u1')?.phoneE164).toBe('+8613900139000');
    expect(JSON.stringify(repository.events)).not.toContain('+8613900139000');
  });

  it('serializes the same concurrent phone-change operation and consumes each proof once', async () => {
    const repository = new MemoryAccountRepository();
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111', '+8613900139000:222222']));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });
    const input = {
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '+8613900139000',
      newPhoneCode: '222222',
      operationId: '0198fabc-1234-7abc-8abc-888888888888',
      eventMetadata: EventMetadata.create(),
    };

    await expect(
      Promise.all([service.changePhone(input), service.changePhone(input)]),
    ).resolves.toEqual([undefined, undefined]);
    expect(verifier.calls).toHaveLength(2);
    expect(repository.events).toHaveLength(1);
  });

  it('does not consume one-time phone proofs again when a serializable transaction retries', async () => {
    const repository = new MemoryAccountRepository();
    repository.simulateSerializationRetryOnce = true;
    const verifier = new CodeVerifier(new Set(['+8613800138000:111111', '+8613900139000:222222']));
    const service = new IdentityAccountService({
      repository,
      smsVerifier: verifier,
      operationFingerprintHasher,
    });

    await service.changePhone({
      userId: 'u1',
      currentPhoneCode: '111111',
      newPhoneE164: '+8613900139000',
      newPhoneCode: '222222',
      operationId: '0198fabc-1234-7abc-8abc-999999999999',
      eventMetadata: EventMetadata.create(),
    });

    expect(verifier.calls).toHaveLength(2);
    expect(repository.users.get('u1')?.phoneE164).toBe('+8613900139000');
    expect(repository.events).toHaveLength(1);
  });

  it('serializes different account operations for the same user', async () => {
    const repository = new MemoryAccountRepository();
    const service = new IdentityAccountService({
      repository,
      smsVerifier: new CodeVerifier(new Set()),
      operationFingerprintHasher,
    });

    await Promise.all([service.updateProfile('u1', 'first'), service.updateProfile('u1', 'second')]);

    expect(repository.maxActiveTransactions).toBe(1);
  });

  it('enforces the frozen 40-character nickname limit', async () => {
    const repository = new MemoryAccountRepository();
    const service = new IdentityAccountService({
      repository,
      smsVerifier: new CodeVerifier(new Set()),
      operationFingerprintHasher,
    });

    await expect(service.updateProfile('u1', 'a'.repeat(40))).resolves.toBeUndefined();
    await expect(service.updateProfile('u1', 'a'.repeat(41))).rejects.toMatchObject({
      code: 'INVALID_NICKNAME',
    });
  });
});
