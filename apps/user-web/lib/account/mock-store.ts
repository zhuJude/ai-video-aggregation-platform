import 'server-only';

import { createHash } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';

import { transactMockStoreJson } from '../commerce/mock-object-store';
import { createUuidV7, isUuidV7 } from '../tasks/identifiers';
import { maskPhone, parseProfile } from './runtime';
import type { ProfileView } from './types';

const COMMAND_TTL_MS = 24 * 60 * 60_000;
const MAX_COMMANDS = 5_000;

export interface StoredSecuritySession {
  readonly id: string;
  readonly deviceName: string;
  readonly locationMasked: string;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly expiresAt: string;
}

interface PhoneChangeState {
  readonly newPhoneE164: string;
  readonly requestedAt: string;
  readonly cooldownUntil: string;
  readonly expiresAt: string;
  readonly attempts: number;
}

interface AccountCommand {
  readonly key: string;
  readonly kind: 'PROFILE' | 'REVOKE' | 'EXIT_ALL' | 'PHONE_REQUEST' | 'PHONE_VERIFY' | 'DELETE';
  readonly fingerprint: string;
  readonly result: unknown;
  readonly expiresAt: string;
}

export interface AccountState {
  readonly version: 1;
  readonly ownerId: string;
  readonly closed: boolean;
  readonly profile: ProfileView;
  readonly sessions: readonly StoredSecuritySession[];
  readonly phoneChange?: PhoneChangeState;
  readonly commands: readonly AccountCommand[];
}

export interface MutableAccountState {
  closed: boolean;
  profile: ProfileView;
  sessions: StoredSecuritySession[];
  phoneChange?: PhoneChangeState;
}

export class AccountStoreError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;
}

function fileName(ownerId: string): string {
  if (process.env.USER_WEB_SUPPORT_MODE !== 'mock') throw new Error('IDENTITY_GATEWAY_UNAVAILABLE');
  if (!UuidSchema.safeParse(ownerId).success) throw new AccountStoreError('INVALID_OWNER');
  return `.account-${createHash('sha256').update(`account:v1:${ownerId}`).digest('hex')}.json`;
}

function parseSession(value: unknown): StoredSecuritySession {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountStoreError('INVALID_STATE');
  const session = value as Record<string, unknown>;
  if (
    Object.keys(session).sort().join(',') !==
      'createdAt,deviceName,expiresAt,id,lastSeenAt,locationMasked' ||
    !isUuidV7(session.id) ||
    typeof session.deviceName !== 'string' ||
    !session.deviceName.trim() ||
    session.deviceName.length > 120 ||
    typeof session.locationMasked !== 'string' ||
    !session.locationMasked ||
    typeof session.createdAt !== 'string' ||
    typeof session.lastSeenAt !== 'string' ||
    typeof session.expiresAt !== 'string' ||
    ![session.createdAt, session.lastSeenAt, session.expiresAt].every((date) =>
      Number.isFinite(Date.parse(date)),
    )
  ) {
    throw new AccountStoreError('INVALID_STATE');
  }
  return session as unknown as StoredSecuritySession;
}

function parseState(value: unknown, ownerId: string): AccountState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AccountStoreError('INVALID_STATE');
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).some(
      (key) =>
        ![
          'version',
          'ownerId',
          'closed',
          'profile',
          'sessions',
          'phoneChange',
          'commands',
        ].includes(key),
    ) ||
    state.version !== 1 ||
    state.ownerId !== ownerId ||
    typeof state.closed !== 'boolean' ||
    !Array.isArray(state.sessions) ||
    !Array.isArray(state.commands)
  )
    throw new AccountStoreError('INVALID_STATE');
  const phoneChange =
    state.phoneChange === undefined ? undefined : (state.phoneChange as Record<string, unknown>);
  if (
    phoneChange &&
    (Object.keys(phoneChange).sort().join(',') !==
      'attempts,cooldownUntil,expiresAt,newPhoneE164,requestedAt' ||
      typeof phoneChange.newPhoneE164 !== 'string' ||
      !/^\+861[3-9]\d{9}$/.test(phoneChange.newPhoneE164) ||
      !Number.isSafeInteger(phoneChange.attempts) ||
      (phoneChange.attempts as number) < 0 ||
      !['requestedAt', 'cooldownUntil', 'expiresAt'].every(
        (key) =>
          typeof phoneChange[key] === 'string' && Number.isFinite(Date.parse(phoneChange[key])),
      ))
  )
    throw new AccountStoreError('INVALID_STATE');
  const commands = state.commands.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new AccountStoreError('INVALID_STATE');
    const command = raw as Record<string, unknown>;
    if (
      Object.keys(command).sort().join(',') !== 'expiresAt,fingerprint,key,kind,result' ||
      !isUuidV7(command.key) ||
      typeof command.fingerprint !== 'string' ||
      !['PROFILE', 'REVOKE', 'EXIT_ALL', 'PHONE_REQUEST', 'PHONE_VERIFY', 'DELETE'].includes(
        command.kind as string,
      ) ||
      typeof command.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(command.expiresAt))
    )
      throw new AccountStoreError('INVALID_STATE');
    return command as unknown as AccountCommand;
  });
  return {
    version: 1,
    ownerId,
    closed: state.closed,
    profile: parseProfile(state.profile),
    sessions: state.sessions.map(parseSession),
    ...(phoneChange ? { phoneChange: phoneChange as unknown as PhoneChangeState } : {}),
    commands,
  };
}

function seed(ownerId: string, currentSessionId: string, verifiedPhone: string): AccountState {
  const now = Date.now();
  return parseState(
    {
      version: 1,
      ownerId,
      closed: false,
      profile: {
        nickname: '光帧创作者',
        phoneMasked: maskPhone(verifiedPhone),
        avatarPreset: 'AMBER',
        updatedAt: new Date(now).toISOString(),
      },
      sessions: [
        {
          id: currentSessionId,
          deviceName: '当前浏览器',
          locationMasked: '本次登录地区',
          createdAt: new Date(now - 60_000).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
        },
        {
          id: createUuidV7(now - 2 * 24 * 60 * 60_000),
          deviceName: 'Windows Chrome',
          locationMasked: '北京',
          createdAt: new Date(now - 2 * 24 * 60 * 60_000).toISOString(),
          lastSeenAt: new Date(now - 3 * 60 * 60_000).toISOString(),
          expiresAt: new Date(now + 28 * 24 * 60 * 60_000).toISOString(),
        },
      ],
      commands: [],
    },
    ownerId,
  );
}

function withCurrent(state: AccountState, currentSessionId: string): AccountState {
  if (state.closed || state.sessions.some(({ id }) => id === currentSessionId)) return state;
  const now = Date.now();
  return parseState(
    {
      ...state,
      sessions: [
        {
          id: currentSessionId,
          deviceName: '当前浏览器',
          locationMasked: '本次登录地区',
          createdAt: new Date(now).toISOString(),
          lastSeenAt: new Date(now).toISOString(),
          expiresAt: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
        },
        ...state.sessions,
      ],
    },
    state.ownerId,
  );
}

export async function readAccountState(
  ownerId: string,
  currentSessionId: string,
  verifiedPhone: string,
): Promise<AccountState> {
  if (!isUuidV7(currentSessionId) || !/^\+861[3-9]\d{9}$/.test(verifiedPhone))
    throw new AccountStoreError('INVALID_CONTEXT');
  const now = Date.now();
  return transactMockStoreJson(fileName(ownerId), (raw) => {
    const initial = parseState(raw ?? seed(ownerId, currentSessionId, verifiedPhone), ownerId);
    const current = withCurrent(initial, currentSessionId);
    const commands = current.commands.filter(({ expiresAt }) => Date.parse(expiresAt) > now);
    const next =
      raw === undefined || current !== initial || commands.length !== current.commands.length
        ? { ...current, commands }
        : undefined;
    return { result: next ? parseState(next, ownerId) : current, ...(next ? { next } : {}) };
  });
}

export async function runAccountCommand<T>(
  context: {
    readonly ownerId: string;
    readonly currentSessionId: string;
    readonly verifiedPhone: string;
  },
  request: {
    readonly key: string;
    readonly kind: AccountCommand['kind'];
    readonly fingerprint: string;
  },
  mutate: (state: MutableAccountState) => T,
): Promise<T> {
  if (!isUuidV7(request.key)) throw new AccountStoreError('INVALID_IDEMPOTENCY_KEY');
  const now = Date.now();
  return transactMockStoreJson(fileName(context.ownerId), (raw) => {
    const seeded = parseState(
      raw ?? seed(context.ownerId, context.currentSessionId, context.verifiedPhone),
      context.ownerId,
    );
    const state = withCurrent(seeded, context.currentSessionId);
    const commands = state.commands.filter(({ expiresAt }) => Date.parse(expiresAt) > now);
    const existing = commands.find(({ key }) => key === request.key);
    if (existing) {
      if (existing.kind !== request.kind || existing.fingerprint !== request.fingerprint)
        throw new AccountStoreError('IDEMPOTENCY_CONFLICT');
      return { result: structuredClone(existing.result) as T };
    }
    if (state.closed) throw new AccountStoreError('ACCOUNT_CLOSED');
    if (commands.length >= MAX_COMMANDS) throw new AccountStoreError('IDEMPOTENCY_CAPACITY');
    const mutable: MutableAccountState = {
      closed: state.closed,
      profile: structuredClone(state.profile),
      sessions: [...structuredClone(state.sessions)],
      ...(state.phoneChange ? { phoneChange: structuredClone(state.phoneChange) } : {}),
    };
    const result = mutate(mutable);
    const next = parseState(
      {
        ...state,
        closed: mutable.closed,
        profile: mutable.profile,
        sessions: mutable.sessions,
        ...(mutable.phoneChange ? { phoneChange: mutable.phoneChange } : {}),
        commands: [
          ...commands,
          {
            key: request.key,
            kind: request.kind,
            fingerprint: request.fingerprint,
            result: structuredClone(result),
            expiresAt: new Date(now + COMMAND_TTL_MS).toISOString(),
          },
        ],
      },
      context.ownerId,
    );
    return { result, next };
  });
}

type AccountCommandReplay =
  { readonly found: false } | { readonly found: true; readonly result: unknown };

export async function replayAccountCommand(
  context: {
    readonly ownerId: string;
    readonly currentSessionId: string;
    readonly verifiedPhone: string;
  },
  request: {
    readonly key: string;
    readonly kind: AccountCommand['kind'];
    readonly fingerprint: string;
  },
): Promise<AccountCommandReplay> {
  if (!isUuidV7(request.key)) throw new AccountStoreError('INVALID_IDEMPOTENCY_KEY');
  return transactMockStoreJson<AccountCommandReplay>(fileName(context.ownerId), (raw) => {
    if (raw === undefined) return { result: { found: false } as const };
    const state = parseState(raw, context.ownerId);
    const existing = state.commands.find(
      ({ key, expiresAt }) => key === request.key && Date.parse(expiresAt) > Date.now(),
    );
    if (!existing) return { result: { found: false } as const };
    if (existing.kind !== request.kind || existing.fingerprint !== request.fingerprint) {
      throw new AccountStoreError('IDEMPOTENCY_CONFLICT');
    }
    return {
      result: { found: true, result: structuredClone(existing.result) } as const,
    };
  });
}
