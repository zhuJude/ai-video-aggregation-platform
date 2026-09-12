import 'server-only';

import { createHmac } from 'node:crypto';

import { closeMockSubject, rebindMockSubjectPhone } from '../auth/mock-subject-store';
import { findMockObject } from '../commerce/mock-object-store';
import { isUuidV7 } from '../tasks/identifiers';
import { maskPhone, validateProfileInput } from './runtime';
import { readAccountState, replayAccountCommand, runAccountCommand } from './mock-store';
import type { AccountGateway, SecuritySessionView } from './types';

export const WS10_IDENTITY_ROUTES = {
  sessions: '/v1/sessions',
  revokeSession: '/v1/sessions/:id',
  profile: '/v1/profile',
  phoneRequest: '/v1/phone-change/sms/request',
  phoneVerify: '/v1/phone-change/sms/verify',
  deletionCodeRequest: '/v1/auth/sms/request',
  closeAccount: '/v1/account',
} as const;

export class AccountGatewayError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;

  constructor(
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

function identityKey(): Buffer {
  const encoded = process.env.USER_WEB_MOCK_IDENTITY_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded))
    throw new Error('MOCK_IDENTITY_KEY_UNAVAILABLE');
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded)
    throw new Error('MOCK_IDENTITY_KEY_UNAVAILABLE');
  return key;
}

function handle(ownerId: string, sessionId: string): string {
  return createHmac('sha256', identityKey())
    .update(`session-handle:v1:${ownerId}:${sessionId}`)
    .digest('base64url')
    .slice(0, 32);
}

function validPhone(phone: string): string {
  const normalized = phone.trim();
  if (!/^\+861[3-9]\d{9}$/.test(normalized)) throw new AccountGatewayError('INVALID_PHONE');
  return normalized;
}

function code(value: string): string {
  if (!/^\d{6}$/.test(value)) throw new AccountGatewayError('INVALID_CODE');
  return value;
}

function contextFingerprint(value: unknown): string {
  return JSON.stringify(value);
}

export const accountGateway: AccountGateway = {
  async getProfile(context) {
    return (
      await readAccountState(context.ownerId, context.currentSessionId, context.verifiedPhone)
    ).profile;
  },

  async updateProfile(input, context) {
    const profile = validateProfileInput(input);
    if (profile.avatarAssetId) {
      const avatar = await findMockObject(profile.avatarAssetId, context.ownerId);
      if (
        !avatar ||
        avatar.state !== 'AVAILABLE' ||
        !/^image\/(?:jpeg|png|webp)$/.test(avatar.mimeType) ||
        BigInt(avatar.sizeBytes) > 5n * 1024n * 1024n
      )
        throw new AccountGatewayError('INVALID_AVATAR');
    }
    return runAccountCommand(
      context,
      {
        key: context.idempotencyKey,
        kind: 'PROFILE',
        fingerprint: `profile:${contextFingerprint(profile)}`,
      },
      (state) => {
        state.profile = { ...state.profile, ...profile, updatedAt: new Date().toISOString() };
        return state.profile;
      },
    );
  },

  async listSessions(context) {
    const state = await readAccountState(
      context.ownerId,
      context.currentSessionId,
      context.verifiedPhone,
    );
    if (state.closed) throw new AccountGatewayError('ACCOUNT_CLOSED');
    const now = Date.now();
    const sessions: SecuritySessionView[] = state.sessions
      .filter(({ expiresAt }) => Date.parse(expiresAt) > now)
      .map((session) => ({
        handle: handle(context.ownerId, session.id),
        deviceName: session.deviceName,
        locationMasked: session.locationMasked,
        createdAt: session.createdAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt,
        current: session.id === context.currentSessionId,
      }));
    return sessions;
  },

  async revokeSession(sessionHandle, context) {
    return runAccountCommand(
      context,
      { key: context.idempotencyKey, kind: 'REVOKE', fingerprint: `revoke:${sessionHandle}` },
      (mutable) => {
        const target = mutable.sessions.find(
          (session) => handle(context.ownerId, session.id) === sessionHandle,
        );
        if (!target) throw new AccountGatewayError('SESSION_NOT_FOUND');
        if (target.id === context.currentSessionId)
          throw new AccountGatewayError('CURRENT_SESSION_PROTECTED');
        mutable.sessions = mutable.sessions.filter(({ id }) => id !== target.id);
        return { revoked: true } as const;
      },
    );
  },

  async exitAll(context) {
    return runAccountCommand(
      context,
      { key: context.idempotencyKey, kind: 'EXIT_ALL', fingerprint: 'exit-all' },
      (state) => {
        state.sessions = [];
        return { signedOut: true } as const;
      },
    );
  },

  async requestPhoneChangeCodes(input, context) {
    const newPhoneE164 = validPhone(input.newPhoneE164);
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.deviceId))
      throw new AccountGatewayError('INVALID_DEVICE');
    const now = Date.now();
    const fingerprint = `phone-request:${contextFingerprint({ newPhoneE164, deviceId: input.deviceId })}`;
    return runAccountCommand(
      context,
      { key: context.idempotencyKey, kind: 'PHONE_REQUEST', fingerprint },
      (state) => {
        if (state.phoneChange && Date.parse(state.phoneChange.cooldownUntil) > now) {
          throw new AccountGatewayError(
            'RATE_LIMITED',
            Math.max(1, Math.ceil((Date.parse(state.phoneChange.cooldownUntil) - now) / 1_000)),
          );
        }
        const requestedAt = new Date().toISOString();
        state.phoneChange = {
          newPhoneE164,
          requestedAt,
          cooldownUntil: new Date(Date.parse(requestedAt) + 60_000).toISOString(),
          expiresAt: new Date(Date.parse(requestedAt) + 10 * 60_000).toISOString(),
          attempts: 0,
        };
        return { cooldownSeconds: 60, message: '如果手机号可用，验证码将尽快发送。' };
      },
    );
  },

  async verifyPhoneChange(input, context) {
    const newPhoneE164 = validPhone(input.newPhoneE164);
    code(input.currentPhoneCode);
    code(input.newPhoneCode);
    if (!isUuidV7(input.operationId) || input.operationId !== context.idempotencyKey)
      throw new AccountGatewayError('INVALID_OPERATION_ID');
    const command = {
      key: context.idempotencyKey,
      kind: 'PHONE_VERIFY' as const,
      fingerprint: `phone-verify:${newPhoneE164}`,
    };
    const replay = await replayAccountCommand(context, command);
    if (replay.found) return replay.result;
    const snapshot = await readAccountState(
      context.ownerId,
      context.currentSessionId,
      context.verifiedPhone,
    );
    if (
      !snapshot.phoneChange ||
      snapshot.phoneChange.newPhoneE164 !== newPhoneE164 ||
      Date.parse(snapshot.phoneChange.expiresAt) <= Date.now() ||
      snapshot.phoneChange.attempts >= 5
    )
      throw new AccountGatewayError('PHONE_VERIFICATION_FAILED');
    if (input.currentPhoneCode !== '123456' || input.newPhoneCode !== '123456') {
      await runAccountCommand(
        context,
        {
          key: context.idempotencyKey,
          kind: 'PHONE_VERIFY',
          fingerprint: `phone-verify-failed:${newPhoneE164}`,
        },
        (state) => {
          if (state.phoneChange)
            state.phoneChange = { ...state.phoneChange, attempts: state.phoneChange.attempts + 1 };
          return { verified: false };
        },
      );
      throw new AccountGatewayError('PHONE_VERIFICATION_FAILED');
    }
    await rebindMockSubjectPhone(context.ownerId, context.verifiedPhone, newPhoneE164);
    return runAccountCommand(context, command, (state) => {
      state.verifiedPhone = newPhoneE164;
      state.profile = {
        ...state.profile,
        phoneMasked: maskPhone(newPhoneE164),
        updatedAt: new Date().toISOString(),
      };
      delete state.phoneChange;
      return { changed: true, verifiedPhone: newPhoneE164 } as const;
    });
  },

  async requestAccountDeletionCode(input, context) {
    if (!/^[a-zA-Z0-9._:-]{1,128}$/.test(input.deviceId))
      throw new AccountGatewayError('INVALID_DEVICE');
    const now = Date.now();
    return runAccountCommand(
      context,
      {
        key: context.idempotencyKey,
        kind: 'DELETE_REQUEST',
        fingerprint: `delete-request:${input.deviceId}`,
      },
      (state) => {
        if (state.deletionChallenge && Date.parse(state.deletionChallenge.cooldownUntil) > now) {
          throw new AccountGatewayError(
            'RATE_LIMITED',
            Math.max(
              1,
              Math.ceil((Date.parse(state.deletionChallenge.cooldownUntil) - now) / 1_000),
            ),
          );
        }
        const requestedAt = new Date(now).toISOString();
        state.deletionChallenge = {
          requestedAt,
          cooldownUntil: new Date(now + 60_000).toISOString(),
          expiresAt: new Date(now + 10 * 60_000).toISOString(),
        };
        return { cooldownSeconds: 60, message: '如果账号可操作，验证码将尽快发送。' };
      },
    );
  },

  async closeAccount(input, context) {
    code(input.code);
    if (!isUuidV7(input.operationId) || input.operationId !== context.idempotencyKey)
      throw new AccountGatewayError('INVALID_OPERATION_ID');
    if (input.code !== '123456') throw new AccountGatewayError('PHONE_VERIFICATION_FAILED');
    const result = await runAccountCommand(
      context,
      { key: context.idempotencyKey, kind: 'DELETE', fingerprint: 'account-delete' },
      (state) => {
        if (!state.deletionChallenge || Date.parse(state.deletionChallenge.expiresAt) <= Date.now())
          throw new AccountGatewayError('FRESH_CHALLENGE_REQUIRED');
        state.closed = true;
        state.sessions = [];
        delete state.deletionChallenge;
        return { closed: true } as const;
      },
    );
    await closeMockSubject(context.ownerId, context.verifiedPhone);
    return result;
  },
};
