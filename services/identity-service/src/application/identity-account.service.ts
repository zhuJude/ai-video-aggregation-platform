import { EventMetadata } from '../domain/event-metadata.js';
import { Phone } from '../domain/phone.js';
import { assertUuidV7, generateUuidV7 } from '../domain/uuid-v7.js';
import type {
  VersionedPrivacyIdentifierDigest,
  VersionedPrivacyIdentifierHasher,
} from '../ports/privacy-identifier.js';
import type { SmsChallengeVerifier } from '../ports/sms-challenge-verifier.js';

export interface AccountUser {
  readonly id: string;
  readonly phoneE164: string;
  readonly nickname: string;
  readonly status: string;
}

export interface OutboxWrite {
  readonly id: string;
  readonly type: 'identity.user-phone-changed.v1' | 'identity.user-closed.v1';
  readonly version: 1;
  readonly aggregateId: string;
  readonly occurredAt: Date;
  readonly traceId: string;
  readonly correlationId: string;
  readonly causationId?: string;
  readonly producer: 'identity-service';
  readonly data: Readonly<{
    userId: string;
    requestFingerprint: string;
    requestFingerprintKeyVersion: string;
  }>;
  readonly dedupeKey: string;
}

export interface AccountMutationLockScope {
  readonly userId: string;
  readonly operationId?: string;
}

export interface OperationResultExpectation {
  readonly dedupeKey: string;
  readonly aggregateId: string;
  readonly type: OutboxWrite['type'];
  readonly requestFingerprints: readonly VersionedPrivacyIdentifierDigest[];
}

export interface AccountMutationTransaction {
  getActiveUser(userId: string): Promise<AccountUser | null>;
  isPhoneAvailable(phoneE164: string, excludingUserId: string): Promise<boolean>;
  updatePhone(userId: string, phoneE164: string): Promise<void>;
  updateNickname(userId: string, nickname: string): Promise<void>;
  closeUser(userId: string): Promise<boolean>;
  revokeAllSessions(userId: string, now: Date): Promise<void>;
  getOperationResult(expectation: OperationResultExpectation): Promise<'missing' | 'completed'>;
  appendOutbox(event: OutboxWrite): Promise<void>;
}

export interface AccountMutationRepository extends AccountMutationTransaction {
  transaction<T>(
    scope: AccountMutationLockScope | null,
    work: (transaction: AccountMutationTransaction) => Promise<T>,
  ): Promise<T>;
  findOrCreateActiveUserByPhone(
    phoneE164: string,
    create: { readonly id: string; readonly nickname: string },
  ): Promise<AccountUser>;
}

export interface IdentityAccountServiceDependencies {
  readonly repository: AccountMutationRepository;
  readonly smsVerifier: SmsChallengeVerifier;
  readonly operationFingerprintHasher: VersionedPrivacyIdentifierHasher;
  readonly uuidV7?: () => string;
  readonly now?: () => Date;
}

export class IdentityAccountService {
  private readonly repository: AccountMutationRepository;
  private readonly smsVerifier: SmsChallengeVerifier;
  private readonly operationFingerprintHasher: VersionedPrivacyIdentifierHasher;
  private readonly uuidV7: () => string;
  private readonly now: () => Date;

  constructor(dependencies: IdentityAccountServiceDependencies) {
    this.repository = dependencies.repository;
    this.smsVerifier = dependencies.smsVerifier;
    this.operationFingerprintHasher = dependencies.operationFingerprintHasher;
    this.uuidV7 = dependencies.uuidV7 ?? generateUuidV7;
    this.now = dependencies.now ?? (() => new Date());
  }

  async authenticatePhone(phoneE164: string, code: string): Promise<AccountUser> {
    const normalizedPhone = normalizePhone(phoneE164);
    if (!(await this.smsVerifier.verify({ phoneE164: normalizedPhone, code }))) {
      throw stableError('PHONE_VERIFICATION_FAILED');
    }
    const userId = this.uuidV7();
    assertUuidV7(userId, 'INVALID_USER_ID');
    return this.repository.findOrCreateActiveUserByPhone(normalizedPhone, {
      id: userId,
      nickname: `用户-${userId.slice(-6)}`,
    });
  }

  async changePhone(input: {
    readonly userId: string;
    readonly currentPhoneCode: string;
    readonly newPhoneE164: string;
    readonly newPhoneCode: string;
    readonly operationId: string;
    readonly eventMetadata: EventMetadata;
  }): Promise<void> {
    validateOperationId(input.operationId);
    EventMetadata.assertTrusted(input.eventMetadata);
    const newPhone = normalizePhone(input.newPhoneE164);
    const dedupeKey = `phone-change:${input.operationId}`;
    const requestFingerprint = await this.fingerprint('phone-change', input.userId, newPhone);
    let verifiedCurrentPhone: string | undefined;
    try {
      await this.repository.transaction(
        { userId: input.userId, operationId: input.operationId },
        async (transaction) => {
          if (
            (await transaction.getOperationResult({
              dedupeKey,
              aggregateId: input.userId,
              type: 'identity.user-phone-changed.v1',
              requestFingerprints: requestFingerprint.candidates,
            })) === 'completed'
          ) {
            return;
          }
          const current = await transaction.getActiveUser(input.userId);
          if (!current) throw stableError('USER_INACTIVE');
          if (current.phoneE164 === newPhone) throw stableError('PHONE_UNCHANGED');
          if (!verifiedCurrentPhone) {
            const [currentResult, newResult] = await Promise.allSettled([
              this.smsVerifier.verify({
                phoneE164: current.phoneE164,
                code: input.currentPhoneCode,
              }),
              this.smsVerifier.verify({ phoneE164: newPhone, code: input.newPhoneCode }),
            ]);
            if (currentResult.status === 'rejected' || newResult.status === 'rejected') {
              throw stableError('SENSITIVE_OPERATION_REVERIFY_REQUIRED');
            }
            if (!currentResult.value && !newResult.value) {
              throw stableError('PHONE_VERIFICATION_FAILED');
            }
            if (!currentResult.value || !newResult.value) {
              throw stableError('SENSITIVE_OPERATION_REVERIFY_REQUIRED');
            }
            verifiedCurrentPhone = current.phoneE164;
          } else if (verifiedCurrentPhone !== current.phoneE164) {
            throw stableError('USER_STATE_CHANGED');
          }
          if (!(await transaction.isPhoneAvailable(newPhone, input.userId))) {
            throw stableError('PHONE_ALREADY_IN_USE');
          }
          await transaction.updatePhone(input.userId, newPhone);
          await transaction.appendOutbox(
            this.event(
              'identity.user-phone-changed.v1',
              input.userId,
              dedupeKey,
              requestFingerprint.current,
              input.eventMetadata,
            ),
          );
        },
      );
    } catch (error: unknown) {
      if (verifiedCurrentPhone && !isExpectedSensitiveOperationError(error)) {
        throw stableError('SENSITIVE_OPERATION_REVERIFY_REQUIRED');
      }
      throw error;
    }
  }

  async closeAccount(input: {
    readonly userId: string;
    readonly code: string;
    readonly operationId: string;
    readonly eventMetadata: EventMetadata;
  }): Promise<void> {
    validateOperationId(input.operationId);
    EventMetadata.assertTrusted(input.eventMetadata);
    const dedupeKey = `account-close:${input.operationId}`;
    const requestFingerprint = await this.fingerprint('account-close', input.userId);
    let verifiedPhone: string | undefined;
    try {
      await this.repository.transaction(
        { userId: input.userId, operationId: input.operationId },
        async (transaction) => {
          if (
            (await transaction.getOperationResult({
              dedupeKey,
              aggregateId: input.userId,
              type: 'identity.user-closed.v1',
              requestFingerprints: requestFingerprint.candidates,
            })) === 'completed'
          ) {
            return;
          }
          const user = await transaction.getActiveUser(input.userId);
          if (!user) return;
          if (!verifiedPhone) {
            let verified: boolean;
            try {
              verified = await this.smsVerifier.verify({
                phoneE164: user.phoneE164,
                code: input.code,
              });
            } catch {
              throw stableError('SENSITIVE_OPERATION_REVERIFY_REQUIRED');
            }
            if (!verified) {
              throw stableError('PHONE_VERIFICATION_FAILED');
            }
            verifiedPhone = user.phoneE164;
          } else if (verifiedPhone !== user.phoneE164) {
            throw stableError('USER_STATE_CHANGED');
          }
          if (!(await transaction.closeUser(input.userId))) return;
          await transaction.revokeAllSessions(input.userId, this.now());
          await transaction.appendOutbox(
            this.event(
              'identity.user-closed.v1',
              input.userId,
              dedupeKey,
              requestFingerprint.current,
              input.eventMetadata,
            ),
          );
        },
      );
    } catch (error: unknown) {
      if (verifiedPhone && !isExpectedSensitiveOperationError(error)) {
        throw stableError('SENSITIVE_OPERATION_REVERIFY_REQUIRED');
      }
      throw error;
    }
  }

  async updateProfile(userId: string, nickname: string): Promise<void> {
    const normalized = nickname.trim();
    if (!normalized || normalized.length > 40) throw stableError('INVALID_NICKNAME');
    await this.repository.transaction({ userId }, async (transaction) => {
      if (!(await transaction.getActiveUser(userId))) throw stableError('USER_INACTIVE');
      await transaction.updateNickname(userId, normalized);
    });
  }

  async currentPhone(userId: string): Promise<string> {
    return (await this.requireActiveUser(userId)).phoneE164;
  }

  private async requireActiveUser(userId: string): Promise<AccountUser> {
    const user = await this.repository.getActiveUser(userId);
    if (!user) throw stableError('USER_INACTIVE');
    return user;
  }

  private event(
    type: OutboxWrite['type'],
    userId: string,
    dedupeKey: string,
    requestFingerprint: VersionedPrivacyIdentifierDigest,
    metadata: EventMetadata,
  ): OutboxWrite {
    const id = this.uuidV7();
    assertUuidV7(id, 'INVALID_EVENT_ID');
    return Object.freeze({
      id,
      type,
      version: 1,
      aggregateId: userId,
      occurredAt: this.now(),
      traceId: metadata.traceId,
      correlationId: metadata.correlationId,
      ...(metadata.causationId ? { causationId: metadata.causationId } : {}),
      producer: 'identity-service',
      data: Object.freeze({
        userId,
        requestFingerprint: requestFingerprint.digest,
        requestFingerprintKeyVersion: requestFingerprint.keyVersion,
      }),
      dedupeKey,
    });
  }

  private async fingerprint(
    operationKind: 'phone-change' | 'account-close',
    userId: string,
    normalizedPhone?: string,
  ): Promise<{
    readonly current: VersionedPrivacyIdentifierDigest;
    readonly candidates: readonly VersionedPrivacyIdentifierDigest[];
  }> {
    const rawIntent = [operationKind, userId, normalizedPhone ?? ''].join('\0');
    const [current, candidates] = await Promise.all([
      this.operationFingerprintHasher.hashCurrent('account-operation', rawIntent),
      this.operationFingerprintHasher.hashCandidates('account-operation', rawIntent),
    ]);
    for (const fingerprint of [current, ...candidates]) {
      if (!/^[0-9a-f]{64}$/.test(fingerprint.digest) || !fingerprint.keyVersion) {
        throw stableError('INVALID_OPERATION_FINGERPRINT');
      }
    }
    if (
      !candidates.some(
        ({ digest, keyVersion }) => digest === current.digest && keyVersion === current.keyVersion,
      )
    ) {
      throw stableError('INVALID_OPERATION_FINGERPRINT');
    }
    return Object.freeze({ current, candidates: Object.freeze([...candidates]) });
  }
}

function validateOperationId(operationId: string): void {
  assertUuidV7(operationId, 'INVALID_OPERATION_ID');
}

function normalizePhone(input: string): string {
  return Phone.parse(input.trim().startsWith('+86') ? input.trim().slice(3) : input).e164;
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function isExpectedSensitiveOperationError(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') {
    return false;
  }
  return new Set([
    'IDEMPOTENCY_KEY_REUSED',
    'PHONE_ALREADY_IN_USE',
    'PHONE_UNCHANGED',
    'PHONE_VERIFICATION_FAILED',
    'USER_INACTIVE',
    'USER_STATE_CHANGED',
  ]).has(error.code);
}
