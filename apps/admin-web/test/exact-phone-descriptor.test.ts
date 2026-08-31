import { describe, expect, it } from 'vitest';

import { sealExactPhoneSearchDescriptor, verifyExactPhoneSearchDescriptor } from '../lib/exact-phone-descriptor';

const signingKey = 'exact-phone-descriptor-key-at-least-32-bytes';
const now = Date.parse('2026-09-03T04:00:00.000Z');
const subjectId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const handle = 'upstream_search_handle_1234567890';
const sessionInstanceId = '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f';
const otherSessionInstanceId = '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f';

function equivalentNonCanonicalBase64Url(value: string): string | undefined {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const decode = (candidate: string) => atob(candidate.replaceAll('-', '+').replaceAll('_', '/').padEnd(Math.ceil(candidate.length / 4) * 4, '='));
  const expected = decode(value);
  for (let index = 0; index < alphabet.length; index += 1) {
    const candidate = `${value.slice(0, -1)}${alphabet[index] ?? ''}`;
    if (candidate !== value && decode(candidate) === expected) return candidate;
  }
  return undefined;
}

describe('exact-phone signed search descriptor', () => {
  it('seals the upstream handle into one bounded base64url token and verifies its binding', async () => {
    const expiresAt = '2026-09-03T04:10:00.000Z';
    const token = await sealExactPhoneSearchDescriptor({ expiresAt, handle, scope: 'ASSIGNED', sessionInstanceId, subjectId }, { now: () => now, signingKey });
    expect(token).toMatch(/^[A-Za-z0-9_-]{32,2048}$/u);
    expect(token).not.toContain(handle);
    await expect(verifyExactPhoneSearchDescriptor(token, { now: () => now, scope: 'ASSIGNED', sessionInstanceId, signingKey, subjectId })).resolves.toEqual({ expiresAt, handle });
  });

  it.each([
    ['tampered token', async (token: string) => verifyExactPhoneSearchDescriptor(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, { now: () => now, scope: 'ASSIGNED', sessionInstanceId, signingKey, subjectId })],
    ['wrong subject', async (token: string) => verifyExactPhoneSearchDescriptor(token, { now: () => now, scope: 'ASSIGNED', sessionInstanceId, signingKey, subjectId: '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f' })],
    ['new session for the same subject', async (token: string) => verifyExactPhoneSearchDescriptor(token, { now: () => now, scope: 'ASSIGNED', sessionInstanceId: otherSessionInstanceId, signingKey, subjectId })],
    ['wrong scope', async (token: string) => verifyExactPhoneSearchDescriptor(token, { now: () => now, scope: 'ALL', sessionInstanceId, signingKey, subjectId })],
    ['expired', async (token: string) => verifyExactPhoneSearchDescriptor(token, { now: () => Date.parse('2026-09-03T04:10:00.001Z'), scope: 'ASSIGNED', sessionInstanceId, signingKey, subjectId })],
    ['wrong key', async (token: string) => verifyExactPhoneSearchDescriptor(token, { now: () => now, scope: 'ASSIGNED', sessionInstanceId, signingKey: 'different-descriptor-key-at-least-32-bytes', subjectId })],
  ])('rejects a %s descriptor before revealing the internal handle', async (_name, verify) => {
    const token = await sealExactPhoneSearchDescriptor({ expiresAt: '2026-09-03T04:10:00.000Z', handle, scope: 'ASSIGNED', sessionInstanceId, subjectId }, { now: () => now, signingKey });
    await expect(verify(token)).rejects.toThrow('搜索凭证无效');
  });

  it('fails closed when the production signing key is missing', async () => {
    await expect(sealExactPhoneSearchDescriptor({ expiresAt: '2026-09-03T04:10:00.000Z', handle, scope: 'ASSIGNED', sessionInstanceId, subjectId }, { now: () => now, signingKey: undefined })).rejects.toThrow('搜索凭证签名配置无效');
  });

  it('rejects a non-canonical base64url alias even when it decodes to the signed bytes', async () => {
    const token = await sealExactPhoneSearchDescriptor({ expiresAt: '2026-09-03T04:10:00.000Z', handle: `${handle}x`, scope: 'ASSIGNED', sessionInstanceId, subjectId }, { now: () => now, signingKey });
    const alternate = equivalentNonCanonicalBase64Url(token) ?? `${token}=`;
    await expect(verifyExactPhoneSearchDescriptor(alternate, { now: () => now, scope: 'ASSIGNED', sessionInstanceId, signingKey, subjectId })).rejects.toThrow('搜索凭证无效');
  });
});
