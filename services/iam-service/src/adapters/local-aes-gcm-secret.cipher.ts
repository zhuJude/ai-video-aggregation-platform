import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes as nodeRandomBytes,
} from 'node:crypto';

import type { SecretCipher } from '../ports/secret-cipher.js';

const PREFIX = 'local-aes256gcm.v1';

export class LocalAesGcmSecretCipher implements SecretCipher {
  private readonly key: Buffer;

  constructor(
    key: Uint8Array,
    private readonly randomBytes: (size: number) => Uint8Array = nodeRandomBytes,
  ) {
    if (key.byteLength !== 32) throw stableError('INVALID_LOCAL_CIPHER_KEY');
    this.key = Buffer.from(
      hkdfSync('sha256', key, Buffer.alloc(0), 'iam-service:local-totp-cipher:v1', 32),
    );
  }

  encrypt(adminId: string, plaintext: string): Promise<string> {
    if (!plaintext) throw stableError('INVALID_SECRET');
    const nonce = Buffer.from(this.randomBytes(12));
    if (nonce.byteLength !== 12) throw stableError('INVALID_CIPHER_NONCE');
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    cipher.setAAD(aad(adminId));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Promise.resolve(
      `${PREFIX}.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`,
    );
  }

  decrypt(adminId: string, envelope: string): Promise<string> {
    try {
      const [prefix, version, nonceValue, ciphertextValue, tagValue, extra] = envelope.split('.');
      if (prefix !== 'local-aes256gcm' || version !== 'v1' || extra !== undefined) {
        throw new Error('BAD_ENVELOPE');
      }
      const nonce = Buffer.from(nonceValue ?? '', 'base64url');
      const ciphertext = Buffer.from(ciphertextValue ?? '', 'base64url');
      const tag = Buffer.from(tagValue ?? '', 'base64url');
      if (nonce.byteLength !== 12 || tag.byteLength !== 16 || ciphertext.byteLength === 0) {
        throw new Error('BAD_ENVELOPE');
      }
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAAD(aad(adminId));
      decipher.setAuthTag(tag);
      return Promise.resolve(
        Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'),
      );
    } catch {
      return Promise.reject(stableError('SECRET_DECRYPTION_FAILED'));
    }
  }
}

function aad(adminId: string): Buffer {
  return Buffer.from(`iam-service:totp-secret:v1:${adminId}`, 'utf8');
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
