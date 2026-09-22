/* eslint-disable @typescript-eslint/require-await */
import { describe, expect, it } from 'vitest';
import { loadUsersView, USER_STATUSES, validateUserFilters } from '../lib/user-view-loaders';
import { signAdminSession } from '../lib/session-auth';

describe('server user view loader', () => {
  it('passes cursor and trusted session to the authoritative search port', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    let received: unknown;
    const view = await loadUsersView(
      {
        query: 'a',
        cursor: 'next',
        filters: { registrationSource: 'WEB', spendingTier: 'HIGH', status: 'ACTIVE', tag: 'vip' },
      },
      {
        context: { sessionToken: token, signingKey: key },
        directoryPort: {
          async searchUsers(input) {
            received = input;
            return {
              items: [
                {
                  id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
                  displayName: '用户',
                  phoneMasked: '138****8000',
                  status: 'ACTIVE',
                },
              ],
              nextCursor: 'n2',
            };
          },
        },
      },
    );
    expect(received).toMatchObject({
      cursor: 'next',
      filters: { registrationSource: 'WEB', spendingTier: 'HIGH', status: 'ACTIVE', tag: 'vip' },
      trustedSessionToken: token,
    });
    const requestContext = (
      received as { requestContext: { correlationId: string; traceId: string } }
    ).requestContext;
    expect(requestContext.correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(requestContext.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(view.items[0]?.phoneMasked).toBe('138****8000');
    expect(view.nextCursor).toBe('n2');
  });

  it('fails closed on a tampered filter before the directory port is called', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    let searches = 0;

    await expect(
      loadUsersView(
        { query: '', filters: { status: 'DROP TABLE' } },
        {
          context: { sessionToken: token, signingKey: key },
          directoryPort: {
            async searchUsers() {
              searches += 1;
              return { items: [], nextCursor: null };
            },
          },
        },
      ),
    ).rejects.toThrow('筛选参数无效');
    expect(searches).toBe(0);
  });

  it('rejects malformed directory rows and cursors before exposing links', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    await expect(
      loadUsersView(
        { query: '' },
        {
          context: { sessionToken: token, signingKey: key },
          directoryPort: {
            async searchUsers() {
              return {
                items: [
                  {
                    id: 'not-a-uuid',
                    displayName: 'x'.repeat(257),
                    phoneMasked: 'invalid',
                    status: 'UNKNOWN',
                  },
                ],
                nextCursor: {} as unknown as string,
              };
            },
          },
        },
      ),
    ).rejects.toThrow('用户目录响应无效');
  });

  it('rejects a directory page beyond the hard item cap and an unsafe cursor', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    const row = {
      id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
      displayName: '用户',
      phoneMasked: '138****8000',
      status: 'ACTIVE',
    };
    await expect(
      loadUsersView(
        { query: '' },
        {
          context: { sessionToken: token, signingKey: key },
          directoryPort: {
            async searchUsers() {
              return { items: Array.from({ length: 101 }, () => row), nextCursor: null };
            },
          },
        },
      ),
    ).rejects.toThrow('用户目录响应无效');
    await expect(
      loadUsersView(
        { query: '' },
        {
          context: { sessionToken: token, signingKey: key },
          directoryPort: {
            async searchUsers() {
              return { items: [], nextCursor: 'next cursor' };
            },
          },
        },
      ),
    ).rejects.toThrow('用户目录响应无效');
  });

  it('fails closed on a phone-shaped ordinary query before the directory port is called', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    let searches = 0;

    await expect(
      loadUsersView(
        { query: '13800138000' },
        {
          context: { sessionToken: token, signingKey: key },
          directoryPort: {
            async searchUsers() {
              searches += 1;
              return { items: [], nextCursor: null };
            },
          },
        },
      ),
    ).rejects.toThrow('敏感查询参数无效');
    expect(searches).toBe(0);
  });

  it.each([
    { query: 'member-13800138000' },
    { query: '', cursor: '+86-138-0013-8000' },
    { query: '', filters: { tag: 'vip-１３８００１３８０００' } },
  ])(
    'rejects sensitive content from every ordinary loader field before the directory port',
    async (input) => {
      const key = 'server-view-loader-signing-key-at-least-32-bytes';
      const sessionToken = await signAdminSession(
        {
          subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
          sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
          permissions: ['users:read'],
          dataScope: 'ALL',
          expiresAt: Date.now() + 60_000,
        },
        key,
      );
      let searches = 0;
      await expect(
        loadUsersView(input, {
          context: { sessionToken, signingKey: key },
          directoryPort: {
            async searchUsers() {
              searches += 1;
              return { items: [], nextCursor: null };
            },
          },
        }),
      ).rejects.toThrow('敏感查询');
      expect(searches).toBe(0);
    },
  );

  it('rejects a malformed cursor before the directory port', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const sessionToken = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    let searches = 0;
    await expect(
      loadUsersView(
        { query: '', cursor: ' bad cursor ' },
        {
          context: { sessionToken, signingKey: key },
          directoryPort: {
            async searchUsers() {
              searches += 1;
              return { items: [], nextCursor: null };
            },
          },
        },
      ),
    ).rejects.toThrow('查询参数无效');
    expect(searches).toBe(0);
  });

  it('exposes exact-phone capability only from the verified server session', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read', 'users:phone-exact'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );

    await expect(
      loadUsersView(
        { query: 'member' },
        {
          context: { sessionToken: token, signingKey: key },
          directoryPort: {
            async searchUsers() {
              return { items: [], nextCursor: null };
            },
          },
        },
      ),
    ).resolves.toMatchObject({ canUseExactPhone: true });
  });

  it('mirrors only ACTIVE, SUSPENDED, and CLOSED identity statuses in filters', () => {
    expect(USER_STATUSES).toEqual(['ACTIVE', 'SUSPENDED', 'CLOSED']);
    expect(validateUserFilters({ status: 'CLOSED' })).toEqual({ status: 'CLOSED' });
    expect(() => validateUserFilters({ status: 'PENDING' })).toThrow('筛选参数无效');
  });

  it.each([
    [{ phoneMasked: '+8613800138000' }, 'international phone'],
    [{ phoneMasked: '1380013800' }, 'short phone'],
    [{ status: 'PENDING' }, 'pending status'],
    [{ status: undefined }, 'missing status'],
  ])('rejects an authoritative directory row with %s', async (override, description) => {
    expect(description).not.toHaveLength(0);
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    const row = {
      id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
      displayName: '用户',
      phoneMasked: '138****8000',
      status: 'ACTIVE',
      ...override,
    };
    await expect(
      loadUsersView(
        { query: '' },
        {
          context: { sessionToken: token, signingKey: key },
          directoryPort: {
            async searchUsers() {
              return { items: [row], nextCursor: null };
            },
          },
        },
      ),
    ).rejects.toThrow('用户目录响应无效');
  });

  it('exposes only the authoritative strict mask regardless of exact-phone query permission', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const permissions = ['users:read', 'users:phone-exact'];
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions,
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    const directoryPort = {
      async searchUsers() {
        return {
          items: [
            {
              id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
              displayName: '用户',
              phoneMasked: '138****8000',
              status: 'CLOSED',
            },
          ],
          nextCursor: null,
        };
      },
    };
    await expect(
      loadUsersView(
        { query: '' },
        { context: { sessionToken: token, signingKey: key }, directoryPort },
      ),
    ).resolves.toMatchObject({ items: [{ phoneMasked: '138****8000', status: 'CLOSED' }] });
  });

  it('accepts only authoritative phoneMasked rows and never reveals plaintext after an exact lookup', async () => {
    const key = 'server-view-loader-signing-key-at-least-32-bytes';
    const token = await signAdminSession(
      {
        subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f',
        sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
        permissions: ['users:read', 'users:phone-exact'],
        dataScope: 'ALL',
        expiresAt: Date.now() + 60_000,
      },
      key,
    );
    const maskedPort = {
      async searchUsers() {
        return {
          items: [
            {
              id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
              displayName: '用户',
              phoneMasked: '138****8000',
              status: 'ACTIVE',
            },
          ],
          nextCursor: null,
        };
      },
    };
    await expect(
      loadUsersView(
        { query: '' },
        { context: { sessionToken: token, signingKey: key }, directoryPort: maskedPort },
      ),
    ).resolves.toMatchObject({ items: [{ phoneMasked: '138****8000' }] });

    const plaintextPort = {
      async searchUsers() {
        return {
          items: [
            {
              id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
              displayName: '用户',
              phone: '13800138000',
              phoneMasked: '138****8000',
              status: 'ACTIVE',
            },
          ],
          nextCursor: null,
        };
      },
    };
    await expect(
      loadUsersView(
        { query: 'member' },
        { context: { sessionToken: token, signingKey: key }, directoryPort: plaintextPort },
      ),
    ).rejects.toThrow('用户目录响应无效');
  });
});
