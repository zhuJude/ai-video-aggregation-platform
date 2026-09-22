import { argon2id, hash, needsRehash, verify } from 'argon2';

import type { PasswordHasher, PasswordVerification } from '../ports/password-hasher.js';

export const ARGON2ID_PASSWORD_POLICY = Object.freeze({
  type: argon2id,
  memoryCost: 65_536,
  timeCost: 3,
  parallelism: 1,
  hashLength: 32,
});
const BOUNDED_INVALID_DIGEST =
  '$argon2id$v=19$m=65536,p=1,t=3$aWFtLWR1bW15LXNhbHQtdjEh$sS8ky5sVrjEWO/XGr1C11lT6qVhj8IbY+eDsxB3/eys';

export class Argon2idPasswordHasher implements PasswordHasher {
  isPolicyDigest(digest: string): boolean {
    const parsed = parseDigest(digest);
    return (
      parsed !== null &&
      parsed.memoryCost === 65_536 &&
      parsed.timeCost === 3 &&
      parsed.parallelism === 1 &&
      parsed.hashLength === 32 &&
      parsed.saltLength >= 16
    );
  }
  async hash(password: string): Promise<string> {
    validatePassword(password);
    return hash(password, ARGON2ID_PASSWORD_POLICY);
  }

  async verify(digest: string, password: string): Promise<PasswordVerification> {
    if (password.length > 1_024) return { valid: false, needsRehash: false };
    const parsed = parseDigest(digest);
    const candidate = parsed ? digest : BOUNDED_INVALID_DIGEST;
    try {
      const verified = await verify(candidate, password);
      const valid = parsed !== null && verified;
      return {
        valid,
        needsRehash: valid && needsRehash(digest, ARGON2ID_PASSWORD_POLICY),
      };
    } catch {
      return { valid: false, needsRehash: false };
    }
  }
}

function parseDigest(digest: string): {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
  saltLength: number;
  hashLength: number;
} | null {
  if (digest.length < 80 || digest.length > 512) return null;
  const match =
    /^\$argon2id\$v=19\$m=(\d+),p=(\d+),t=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(digest);
  if (!match) return null;
  const memoryCost = Number(match[1]),
    parallelism = Number(match[2]),
    timeCost = Number(match[3]);
  if (
    !Number.isSafeInteger(memoryCost) ||
    !Number.isSafeInteger(timeCost) ||
    !Number.isSafeInteger(parallelism) ||
    memoryCost < 8_192 ||
    memoryCost > 65_536 ||
    timeCost < 1 ||
    timeCost > 3 ||
    parallelism < 1 ||
    parallelism > 1
  )
    return null;
  const salt = match[4],
    encodedHash = match[5];
  if (!salt || !encodedHash) return null;
  try {
    const saltLength = Buffer.from(salt, 'base64').byteLength,
      hashLength = Buffer.from(encodedHash, 'base64').byteLength;
    if (saltLength < 16 || saltLength > 64 || hashLength !== 32) return null;
    return { memoryCost, timeCost, parallelism, saltLength, hashLength };
  } catch {
    return null;
  }
}

function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 1_024) throw stableError('INVALID_PASSWORD');
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
