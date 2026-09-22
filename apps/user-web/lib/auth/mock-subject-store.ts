import 'server-only';

import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';

import { transactMockStoreJson } from '../commerce/mock-object-store';
import { createUuidV7 } from '../tasks/identifiers';

const VERIFIED_PHONE = /^\+861[3-9]\d{9}$/;
const DEMO_SUBJECTS: Readonly<Record<string, string>> = {
  '+8613800138000': '0198f4d4-21c2-7b7d-8a03-08a0da2a7401',
  '+8613900139000': '0198f4d4-21c2-7b7d-8a03-08a0da2a7402',
};

interface SubjectBinding {
  readonly encryptedPhone?: string;
  readonly phoneDigest: string;
  readonly subjectId: string;
  readonly state: 'ACTIVE' | 'REBOUND' | 'CLOSED';
  readonly updatedAt: string;
}

function encryptPhone(phone: string, subjectId: string, phoneDigest: string): string {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', identityKey(), nonce);
  cipher.setAAD(Buffer.from(`mock-subject-phone:v1:${subjectId}:${phoneDigest}`));
  const encrypted = Buffer.concat([
    cipher.update(phone, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${nonce.toString('base64url')}.${encrypted.toString('base64url')}`;
}

function decryptPhone(binding: SubjectBinding): string {
  if (!binding.encryptedPhone) throw new Error('SUBJECT_PHONE_UNAVAILABLE');
  try {
    const [encodedNonce, encodedPayload, extra] = binding.encryptedPhone.split('.');
    if (!encodedNonce || !encodedPayload || extra) throw new Error('INVALID_PHONE_CIPHERTEXT');
    const nonce = Buffer.from(encodedNonce, 'base64url');
    const payload = Buffer.from(encodedPayload, 'base64url');
    if (nonce.length !== 12 || payload.length <= 16) throw new Error('INVALID_PHONE_CIPHERTEXT');
    const decipher = createDecipheriv('aes-256-gcm', identityKey(), nonce);
    decipher.setAAD(
      Buffer.from(`mock-subject-phone:v1:${binding.subjectId}:${binding.phoneDigest}`),
    );
    decipher.setAuthTag(payload.subarray(payload.length - 16));
    const phone = Buffer.concat([
      decipher.update(payload.subarray(0, payload.length - 16)),
      decipher.final(),
    ]).toString('utf8');
    if (!VERIFIED_PHONE.test(phone) || digestPhone(phone) !== binding.phoneDigest)
      throw new Error('INVALID_PHONE_CIPHERTEXT');
    return phone;
  } catch {
    throw new Error('SUBJECT_PHONE_UNAVAILABLE');
  }
}

interface SubjectMap {
  readonly version: 1;
  readonly bindings: readonly SubjectBinding[];
}

function identityKey(): Buffer {
  const encoded = process.env.USER_WEB_MOCK_IDENTITY_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error('MOCK_IDENTITY_KEY_UNAVAILABLE');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) {
    throw new Error('MOCK_IDENTITY_KEY_UNAVAILABLE');
  }
  return key;
}

function digestPhone(phone: string): string {
  if (!VERIFIED_PHONE.test(phone)) throw new Error('INVALID_VERIFIED_PHONE');
  return createHmac('sha256', identityKey()).update(`mock-subject:v1:${phone}`).digest('hex');
}

function fileName(): string {
  const keyFingerprint = createHmac('sha256', identityKey())
    .update('mock-subject-map-namespace:v2')
    .digest('hex')
    .slice(0, 24);
  return `.identity-subject-map-v2-${keyFingerprint}.json`;
}

function parseMap(value: unknown): SubjectMap {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('INVALID_SUBJECT_MAP');
  const map = value as Record<string, unknown>;
  if (
    Object.keys(map).sort().join(',') !== 'bindings,version' ||
    map.version !== 1 ||
    !Array.isArray(map.bindings)
  ) {
    throw new Error('INVALID_SUBJECT_MAP');
  }
  const bindings = map.bindings.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new Error('INVALID_SUBJECT_MAP');
    const binding = raw as Record<string, unknown>;
    if (
      ![
        'encryptedPhone,phoneDigest,state,subjectId,updatedAt',
        'phoneDigest,state,subjectId,updatedAt',
      ].includes(Object.keys(binding).sort().join(',')) ||
      typeof binding.phoneDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(binding.phoneDigest) ||
      !UuidSchema.safeParse(binding.subjectId).success ||
      !['ACTIVE', 'REBOUND', 'CLOSED'].includes(binding.state as string) ||
      (binding.encryptedPhone !== undefined &&
        (typeof binding.encryptedPhone !== 'string' || binding.encryptedPhone.length > 256)) ||
      typeof binding.updatedAt !== 'string' ||
      !Number.isFinite(Date.parse(binding.updatedAt))
    ) {
      throw new Error('INVALID_SUBJECT_MAP');
    }
    return {
      phoneDigest: binding.phoneDigest,
      ...(binding.encryptedPhone ? { encryptedPhone: binding.encryptedPhone } : {}),
      subjectId: binding.subjectId as string,
      state: binding.state as SubjectBinding['state'],
      updatedAt: binding.updatedAt,
    };
  });
  if (new Set(bindings.map((binding) => binding.phoneDigest)).size !== bindings.length) {
    throw new Error('INVALID_SUBJECT_MAP');
  }
  return { version: 1, bindings };
}

async function transact<T>(
  update: (bindings: SubjectBinding[]) => {
    readonly result: T;
    readonly bindings?: SubjectBinding[];
  },
): Promise<T> {
  return transactMockStoreJson(fileName(), (raw) => {
    const state = parseMap(raw ?? { version: 1, bindings: [] });
    const outcome = update([...state.bindings]);
    return {
      result: outcome.result,
      ...(outcome.bindings ? { next: parseMap({ version: 1, bindings: outcome.bindings }) } : {}),
    };
  });
}

export async function resolveExistingMockSubjectForVerifiedPhone(
  verifiedPhone: string,
): Promise<string | undefined> {
  const digest = digestPhone(verifiedPhone);
  return transact((bindings) => ({
    result: bindings.find((binding) => binding.phoneDigest === digest && binding.state === 'ACTIVE')
      ?.subjectId,
  }));
}

export async function resolveOrCreateMockSubjectForVerifiedPhone(
  verifiedPhone: string,
): Promise<string> {
  const digest = digestPhone(verifiedPhone);
  return transact((bindings) => {
    const existing = bindings.find((binding) => binding.phoneDigest === digest);
    if (existing?.state === 'ACTIVE') {
      if (existing.encryptedPhone) return { result: existing.subjectId };
      return {
        result: existing.subjectId,
        bindings: bindings.map((binding) =>
          binding.phoneDigest === digest
            ? { ...binding, encryptedPhone: encryptPhone(verifiedPhone, binding.subjectId, digest) }
            : binding,
        ),
      };
    }
    if (existing?.state === 'CLOSED') throw new Error('ACCOUNT_CLOSED');
    const subjectId = (!existing ? DEMO_SUBJECTS[verifiedPhone] : undefined) ?? createUuidV7();
    const created: SubjectBinding = {
      phoneDigest: digest,
      encryptedPhone: encryptPhone(verifiedPhone, subjectId, digest),
      subjectId,
      state: 'ACTIVE',
      updatedAt: new Date().toISOString(),
    };
    return {
      result: subjectId,
      bindings: existing
        ? bindings.map((binding) => (binding.phoneDigest === digest ? created : binding))
        : [...bindings, created],
    };
  });
}

export async function resolveCurrentVerifiedPhoneForMockSubject(
  subjectId: string,
): Promise<string> {
  if (!UuidSchema.safeParse(subjectId).success) throw new Error('INVALID_SUBJECT');
  return transact((bindings) => {
    const active = bindings.filter(
      (binding) => binding.subjectId === subjectId && binding.state === 'ACTIVE',
    );
    if (active.length !== 1) throw new Error('SUBJECT_BINDING_NOT_FOUND');
    return { result: decryptPhone(active[0] as SubjectBinding) };
  });
}

export async function rebindMockSubjectPhone(
  subjectId: string,
  currentVerifiedPhone: string,
  newVerifiedPhone: string,
): Promise<void> {
  const parsedSubject = UuidSchema.safeParse(subjectId);
  if (!parsedSubject.success) throw new Error('INVALID_PHONE_REBIND');
  const currentDigest = digestPhone(currentVerifiedPhone);
  const newDigest = digestPhone(newVerifiedPhone);
  await transact((bindings) => {
    if (currentDigest === newDigest) {
      const active = bindings.find(
        (binding) => binding.phoneDigest === newDigest && binding.state === 'ACTIVE',
      );
      if (active?.subjectId !== subjectId) throw new Error('SUBJECT_BINDING_NOT_FOUND');
      return { result: undefined };
    }
    const current = bindings.find((binding) => binding.phoneDigest === currentDigest);
    const destination = bindings.find((binding) => binding.phoneDigest === newDigest);
    if (
      current?.state === 'REBOUND' &&
      current.subjectId === subjectId &&
      destination?.state === 'ACTIVE' &&
      destination.subjectId === subjectId
    ) {
      return { result: undefined };
    }
    if (!current || current.state !== 'ACTIVE' || current.subjectId !== subjectId) {
      throw new Error('SUBJECT_BINDING_NOT_FOUND');
    }
    if (destination?.state === 'ACTIVE' && destination.subjectId !== subjectId) {
      throw new Error('PHONE_ALREADY_IN_USE');
    }
    const now = new Date().toISOString();
    const withoutDestination = bindings.filter((binding) => binding.phoneDigest !== newDigest);
    return {
      result: undefined,
      bindings: [
        ...withoutDestination.map((binding) =>
          binding.phoneDigest === currentDigest
            ? { ...binding, state: 'REBOUND' as const, updatedAt: now }
            : binding,
        ),
        {
          phoneDigest: newDigest,
          encryptedPhone: encryptPhone(newVerifiedPhone, subjectId, newDigest),
          subjectId,
          state: 'ACTIVE',
          updatedAt: now,
        },
      ],
    };
  });
}

export async function closeMockSubject(subjectId: string, verifiedPhone: string): Promise<void> {
  const parsedSubject = UuidSchema.safeParse(subjectId);
  if (!parsedSubject.success) throw new Error('INVALID_SUBJECT');
  const digest = digestPhone(verifiedPhone);
  await transact((bindings) => {
    if (bindings.some((binding) => binding.subjectId === subjectId && binding.state === 'CLOSED')) {
      return { result: undefined };
    }
    const current = bindings.find((binding) => binding.phoneDigest === digest);
    if (current?.state === 'CLOSED' && current.subjectId === subjectId) {
      return { result: undefined };
    }
    if (!current || current.state !== 'ACTIVE' || current.subjectId !== subjectId) {
      throw new Error('SUBJECT_BINDING_NOT_FOUND');
    }
    const now = new Date().toISOString();
    return {
      result: undefined,
      bindings: bindings.map((binding) =>
        binding.subjectId === subjectId && binding.state === 'ACTIVE'
          ? { ...binding, state: 'CLOSED' as const, updatedAt: now }
          : binding,
      ),
    };
  });
}
