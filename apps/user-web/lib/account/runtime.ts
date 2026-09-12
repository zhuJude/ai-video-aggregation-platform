import { UtcDateTimeSchema } from '@repo/contracts/common';

import type { ProfileView, SecuritySessionView } from './types';

const AVATAR_PRESETS = new Set<ProfileView['avatarPreset']>(['AMBER', 'BLUE', 'GREEN', 'PLUM']);

function record(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function exact(value: Record<string, unknown>, keys: readonly string[], code: string): void {
  const allowed = new Set(keys);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error(code);
}

function instant(value: unknown, code: string): string {
  const parsed = UtcDateTimeSchema.safeParse(value);
  if (!parsed.success) throw new Error(code);
  return parsed.data;
}

function text(value: unknown, code: string, max: number): string {
  if (typeof value !== 'string') throw new Error(code);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > max ||
    Array.from(normalized).some((character) => {
      const characterCode = character.charCodeAt(0);
      return characterCode < 32 || characterCode === 127;
    })
  )
    throw new Error(code);
  return normalized;
}

export function validateProfileInput(input: {
  readonly nickname: string;
  readonly avatarPreset: ProfileView['avatarPreset'];
}) {
  const nickname = text(input.nickname, 'INVALID_PROFILE', 40);
  if (!AVATAR_PRESETS.has(input.avatarPreset)) throw new Error('INVALID_PROFILE');
  return { nickname, avatarPreset: input.avatarPreset };
}

export function parseProfile(value: unknown): ProfileView {
  const profile = record(value, 'INVALID_PROFILE');
  exact(profile, ['nickname', 'phoneMasked', 'avatarPreset', 'updatedAt'], 'INVALID_PROFILE');
  if (!AVATAR_PRESETS.has(profile.avatarPreset as ProfileView['avatarPreset']))
    throw new Error('INVALID_PROFILE');
  if (typeof profile.phoneMasked !== 'string' || !/^1\d{2}\*{4}\d{4}$/.test(profile.phoneMasked))
    throw new Error('INVALID_PROFILE');
  return {
    nickname: text(profile.nickname, 'INVALID_PROFILE', 40),
    phoneMasked: profile.phoneMasked,
    avatarPreset: profile.avatarPreset as ProfileView['avatarPreset'],
    updatedAt: instant(profile.updatedAt, 'INVALID_PROFILE'),
  };
}

export function parseSecuritySessions(value: unknown): readonly SecuritySessionView[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('INVALID_SESSIONS');
  const sessions = value.map((raw) => {
    const session = record(raw, 'INVALID_SESSIONS');
    exact(
      session,
      ['handle', 'deviceName', 'locationMasked', 'createdAt', 'lastSeenAt', 'expiresAt', 'current'],
      'INVALID_SESSIONS',
    );
    if (
      typeof session.handle !== 'string' ||
      !/^[A-Za-z0-9_-]{22,64}$/.test(session.handle) ||
      typeof session.current !== 'boolean'
    ) {
      throw new Error('INVALID_SESSIONS');
    }
    return {
      handle: session.handle,
      deviceName: text(session.deviceName, 'INVALID_SESSIONS', 120),
      locationMasked: text(session.locationMasked, 'INVALID_SESSIONS', 40),
      createdAt: instant(session.createdAt, 'INVALID_SESSIONS'),
      lastSeenAt: instant(session.lastSeenAt, 'INVALID_SESSIONS'),
      expiresAt: instant(session.expiresAt, 'INVALID_SESSIONS'),
      current: session.current,
    };
  });
  if (sessions.filter(({ current }) => current).length !== 1) throw new Error('INVALID_SESSIONS');
  return sessions;
}

export function maskPhone(verifiedPhone: string): string {
  if (!/^\+861[3-9]\d{9}$/.test(verifiedPhone)) throw new Error('INVALID_VERIFIED_PHONE');
  return `${verifiedPhone.slice(3, 6)}****${verifiedPhone.slice(-4)}`;
}

const DATE_FORMATTER = new Intl.DateTimeFormat('zh-CN', {
  dateStyle: 'medium',
  timeStyle: 'short',
  timeZone: 'Asia/Shanghai',
});

export function formatAccountDate(value: string): string {
  return DATE_FORMATTER.format(new Date(instant(value, 'INVALID_ACCOUNT_DATE')));
}
