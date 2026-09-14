import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readOfficialStsSession } from '../src/adapters/aliyun-workload-identity.js';

describe('operations official STS session expiration', () => {
  it('uses the SDK session Expiration without synthesizing a local lifetime', async () => {
    const now = new Date('2026-09-15T00:00:00.000Z');
    const provider = {
      getSession: vi.fn().mockResolvedValue({
        accessKeyId: 'id',
        accessKeySecret: 'secret',
        securityToken: 'token',
        expiration: '2026-09-15T00:00:45.000Z',
      }),
    };
    await expect(readOfficialStsSession(provider, now)).resolves.toMatchObject({
      expiresAt: new Date('2026-09-15T00:00:45.000Z'),
    });
  });

  it('production wiring has no synthetic credential expiration', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../src/main.ts'), 'utf8');
    expect(source).toContain('readOfficialStsSession');
    expect(source).not.toMatch(/expiresAt:\s*new Date\(Date\.now\(\)\s*\+/);
  });
});
