import { fireEvent, render, screen } from '@testing-library/react';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: navigation.push }) }));

import { UserDirectorySearchForm } from '../components/user-directory-search-form';
import { containsSensitivePhoneLikeValue, sanitizeUsersSearchParams } from '../lib/sensitive-query';
import { proxy } from '../proxy';
import { signAdminSession } from '../lib/session-auth';

describe('single sensitive-query boundary', () => {
  const unicodePhoneDigits = [
    '١٣٨٠٠١٣٨٠٠٠',
    '۱۳۸۰۰۱۳۸۰۰۰',
    '१३८००१३८०००',
    '１３８００１３８０００',
    '𝟙𝟛𝟠𝟘𝟘𝟙𝟛𝟠𝟘𝟘𝟘',
    '1٣८０0۱3٨०0٠',
  ];

  it.each([
    '13800138000',
    'member-13800138000-vip',
    '+86 138-0013-8000',
    '（+86）138 0013 8000',
    '用户１３８００１３８０００',
    'member-%252B86%2520138-0013-8000',
    '138/0013/8000',
    '138,0013,8000',
    `138\u200b0013\u200b8000`,
    `1\u03003800138000`,
    `138\ufe0f0013\ufe0e8000`,
    '138😀0013🚀8000',
    `138👨‍👩‍👧‍👦0013\u20608000`,
    `138\n0013\r8000`,
    `138\u00000013\u00018000`,
    `138\ue0000013\u03788000`,
    `138\ud8000013\udfff8000`,
    '138%0A0013%0D8000',
    '138%00%30%30%31%33%38%30%30%30',
    'x%ZZ%31%33%38%30%30%31%33%38%30%30%30',
  ])('detects exact, wrapped, international, separated, and full-width phone-like values: %s', (value) => {
    expect(containsSensitivePhoneLikeValue(value)).toBe(true);
  });

  it.each(unicodePhoneDigits)('maps every Unicode Nd script before detecting a phone: %s', (value) => {
    expect(containsSensitivePhoneLikeValue(`member/${value}/vip`)).toBe(true);
  });

  it.each(['增长 100%', '%ZZ普通文本', '%E0%A4%A普通文本', '普通文本%25', '普通😀文本', 'cafe\u0301'])('does not reject harmless malformed or bare percent text: %s', (value) => {
    expect(containsSensitivePhoneLikeValue(value)).toBe(false);
  });

  it.each(['普通\n文本', '\u0000普通文本', '普通\ue000文本', '普通\u0378文本', '普通\ud800文本', '普通%0D文本'])(
    'fails closed on standalone control/private/unassigned values before they reach client or logs: %s',
    (value) => { expect(containsSensitivePhoneLikeValue(value)).toBe(true); },
  );

  it('drops unknown parameters, removes malformed known values, and reports a safe rejection without echoing input', () => {
    const result = sanitizeUsersSearchParams({ cursor: 'bad cursor', future: 'prefix-13800138000', query: 'member', status: 'PENDING' });
    expect(result).toEqual({ params: { query: 'member' }, rejected: true });
    expect(JSON.stringify(result)).not.toContain('13800138000');
  });
});

describe('controlled ordinary user search', () => {
  beforeEach(() => { navigation.push.mockReset(); });

  it.each(['13800138000', 'member-13800138000', '+86 138-0013-8000', '１３８００１３８０００', '١٣٨٠٠١٣٨٠٠٠', '۱۳۸۰۰۱۳۸۰۰۰', '१३८००१३८०००', '𝟙𝟛𝟠𝟘𝟘𝟙𝟛𝟠𝟘𝟘𝟘', '1٣८０0۱3٨۰0٠', '138/0013/8000', '138,0013,8000', `138\u200b0013\u200b8000`, `1\u03003800138000`, `138\ufe0f0013\ufe0e8000`, '138😀0013🚀8000', `138👨‍👩‍👧‍👦0013\u20608000`, `138\n0013\r8000`, `138\ue0000013\u03788000`, `138\ud8000013\udfff8000`, '138%0A0013%0D8000', 'x%ZZ%31%33%38%30%30%31%33%38%30%30%30'])(
    'blocks phone-like text before it can enter router history: %s',
    (value) => {
      const { container } = render(<UserDirectorySearchForm initialFilters={{}} initialQuery="" />);
      fireEvent.change(screen.getByRole('textbox', { name: /用户名/u }), { target: { value } });
      fireEvent.click(screen.getByRole('button', { name: '服务端查询' }));
      expect(navigation.push).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toHaveTextContent('受保护的精确手机号查询');
      expect(container.innerHTML).not.toContain(value);
    },
  );

  it('constructs a GET URL only after a normal search value passes the shared detector', () => {
    render(<UserDirectorySearchForm initialFilters={{ status: 'ACTIVE' }} initialQuery="" />);
    expect(screen.getByRole('button', { name: '服务端查询' }).closest('form')).toHaveAttribute('method', 'post');
    fireEvent.change(screen.getByRole('textbox', { name: /用户名/u }), { target: { value: 'member' } });
    fireEvent.click(screen.getByRole('button', { name: '服务端查询' }));
    expect(navigation.push).toHaveBeenCalledWith('/users?query=member&status=ACTIVE');
  });

  it('clears a sensitive filter value as well as refusing navigation', () => {
    render(<UserDirectorySearchForm initialFilters={{}} initialQuery="member" />);
    const tag = screen.getByRole('textbox', { name: '用户标签' });
    fireEvent.change(tag, { target: { value: 'vip-138 0013 8000' } });
    fireEvent.click(screen.getByRole('button', { name: '服务端查询' }));
    expect(navigation.push).not.toHaveBeenCalled();
    expect(tag).toHaveValue('');
  });
});

describe('unauthenticated return-location minimization', () => {
  it.each([
    '/users/13800138000',
    '/users/member-13800138000',
    '/users/%2B86%20138-0013-8000',
    '/users/138/0013/8000',
    '/users/138,0013,8000',
    `/users/138\u200b0013\u200b8000`,
    `/users/1\u03003800138000`,
    `/users/138\ufe0f0013\ufe0e8000`,
    '/users/138😀0013🚀8000',
    '/users/138%0A0013%0D8000',
    '/users/138%00%30%30%31%33%38%30%30%30',
    `/users/138\ue0000013\u03788000`,
    `/users/138\ud8000013\udfff8000`,
    '/users/%EF%BC%91%EF%BC%93%EF%BC%98%EF%BC%90%EF%BC%90%EF%BC%91%EF%BC%93%EF%BC%98%EF%BC%90%EF%BC%90%EF%BC%90',
    '/users/x%25ZZ%2531%2533%2538%2530%2530%2531%2533%2538%2530%2530%2530',
    '/users%252F%2531%2533%2538%2530%2530%2531%2533%2538%2530%2530%2530',
    '/users/not-a-user-id',
  ])('canonicalizes an invalid or sensitive user detail pathname before authentication: %s', async (path) => {
    const response = await proxy(new NextRequest(`https://admin.ai-video.internal${path}`));
    const location = response.headers.get('location') ?? '';
    expect(response.status).toBe(307);
    expect(decodeURIComponent(location)).toBe('https://admin.ai-video.internal/users?notice=sensitive-query-removed');
    expect(location).not.toMatch(/13800138000|１３８００１３８０００/u);
  });

  it.each(['138%0A0013%0D8000', '138%00%30%30%31%33%38%30%30%30', `138\ue0000013\u03788000`])(
    'removes control/private-use phone-like values from query and nested next: %s',
    async (value) => {
      for (const url of [
        `https://admin.ai-video.internal/users?query=${value}`,
        `https://admin.ai-video.internal/login?next=${encodeURIComponent(`/users?tag=${value}`)}`,
      ]) {
        const response = await proxy(new NextRequest(url));
        const location = response.headers.get('location') ?? '';
        expect(location).not.toMatch(/13800138000|%0A|%0D|%00/u);
      }
    },
  );

  it.each(['١٣٨٠٠١٣٨٠٠٠', '۱۳۸۰۰۱۳۸۰۰۰', '१३८००१३८०००', '𝟙𝟛𝟠𝟘𝟘𝟙𝟛𝟠𝟘𝟘𝟘', '1٣८０0۱3٨۰0٠'])(
    'removes Unicode Nd phone-like values from paths, queries, and nested login next: %s',
    async (value) => {
      for (const url of [
        `https://admin.ai-video.internal/users/${value}`,
        `https://admin.ai-video.internal/users?query=${encodeURIComponent(value)}`,
        `https://admin.ai-video.internal/login?next=${encodeURIComponent(`/users?tag=${value}`)}`,
      ]) {
        const response = await proxy(new NextRequest(url));
        const location = response.headers.get('location') ?? '';
        expect(location).not.toContain(value);
        expect(decodeURIComponent(location)).not.toContain(value);
      }
    },
  );

  it.each([
    '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f',
    '0198F7A4-C6D1-7B39-8A4E-73AF0C1D2E3F',
  ])('preserves a valid UUIDv7 user detail return path: %s', async (userId) => {
    const response = await proxy(new NextRequest(`https://admin.ai-video.internal/users/${userId}`));
    expect(response.status).toBe(307);
    expect(decodeURIComponent(response.headers.get('location') ?? '')).toBe(`https://admin.ai-video.internal/login?next=/users/${userId}`);
  });

  it('allows a valid uppercase UUIDv7 detail path after canonicalization and authorization', async () => {
    const signingKey = 'proxy-sensitive-signing-key-at-least-32-bytes';
    const sessionToken = await signAdminSession({ dataScope: 'OWN', expiresAt: Date.now() + 60_000, permissions: ['users:read'], sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f', subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }, signingKey);
    process.env.ADMIN_SESSION_SIGNING_KEY = signingKey;
    try {
      const response = await proxy(new NextRequest('https://admin.ai-video.internal/users/0198F7A4-C6D1-7B39-8A4E-73AF0C1D2E3F', { headers: { cookie: `__Host-admin_session=${sessionToken}` } }));
      expect(response.status).toBe(200);
      expect(response.headers.get('location')).toBeNull();
    } finally {
      delete process.env.ADMIN_SESSION_SIGNING_KEY;
    }
  });

  it.each(['/users/', '/users/0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f/'])(
    'removes a non-canonical trailing slash before authentication: %s',
    async (path) => {
      const response = await proxy(new NextRequest(`https://admin.ai-video.internal${path}`));
      expect(response.status).toBe(307);
      expect(response.headers.get('location')).toBe(`https://admin.ai-video.internal${path.slice(0, -1)}`);
    },
  );

  it.each([
    '/users?query=13800138000',
    '/users?query=member-13800138000-vip',
    '/users?query=%2B86%20138-0013-8000',
    '/users?cursor=next-13800138000',
    '/users?tag=vip-13800138000',
    '/users?status=ACTIVE-13800138000',
    '/users?future=%EF%BC%91%EF%BC%93%EF%BC%98%EF%BC%90%EF%BC%90%EF%BC%91%EF%BC%93%EF%BC%98%EF%BC%90%EF%BC%90%EF%BC%90',
  ])('never copies a sensitive browser parameter into the 307 Location: %s', async (path) => {
    const response = await proxy(new NextRequest(`https://admin.ai-video.internal${path}`));
    const location = response.headers.get('location') ?? '';
    expect(response.status).toBe(307);
    expect(decodeURIComponent(location)).toBe('https://admin.ai-video.internal/users?notice=sensitive-query-removed');
    expect(location).not.toContain('13800138000');
  });

  it.each([
    '/login?next=%2Fusers%3Fquery%3D13800138000',
    '/login?next=%252Fusers%253Fquery%253D%25252B86%252520138-0013-8000',
  ])('sanitizes a recursively encoded login return location before the public-route exemption: %s', async (path) => {
    const response = await proxy(new NextRequest(`https://admin.ai-video.internal${path}`));
    expect(response.status).toBe(307);
    expect(response.headers.get('location')).toBe('https://admin.ai-video.internal/login');
  });

  it('sanitizes a forbidden users request and a detail unknown parameter before authorization', async () => {
    const signingKey = 'proxy-sensitive-signing-key-at-least-32-bytes';
    const sessionToken = await signAdminSession({ dataScope: 'OWN', expiresAt: Date.now() + 60_000, permissions: [], sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f', subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' }, signingKey);
    process.env.ADMIN_SESSION_SIGNING_KEY = signingKey;
    try {
      const forbidden = await proxy(new NextRequest('https://admin.ai-video.internal/users?tag=member-%2B86%20138-0013-8000', { headers: { cookie: `__Host-admin_session=${sessionToken}` } }));
      expect(forbidden.status).toBe(307);
      expect(decodeURIComponent(forbidden.headers.get('location') ?? '')).toBe('https://admin.ai-video.internal/users?notice=sensitive-query-removed');
      const detail = await proxy(new NextRequest('https://admin.ai-video.internal/users/0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f?future=prefix-１３８００１３８０００', { headers: { cookie: `__Host-admin_session=${sessionToken}` } }));
      expect(detail.status).toBe(307);
      expect(detail.headers.get('location')).toBe('https://admin.ai-video.internal/users/0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f');
    } finally {
      delete process.env.ADMIN_SESSION_SIGNING_KEY;
    }
  });

  it('immediately canonicalizes an authenticated sensitive URL without echoing it', async () => {
    const signingKey = 'proxy-sensitive-signing-key-at-least-32-bytes';
    const sessionToken = await signAdminSession({ dataScope: 'OWN', expiresAt: Date.now() + 60_000, permissions: ['users:read'], subjectId: '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f' , sessionInstanceId: "0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f"}, signingKey);
    process.env.ADMIN_SESSION_SIGNING_KEY = signingKey;
    try {
      const response = await proxy(new NextRequest('https://admin.ai-video.internal/users?query=member&tag=vip-13800138000', { headers: { cookie: `__Host-admin_session=${sessionToken}` } }));
      const location = decodeURIComponent(response.headers.get('location') ?? '');
      expect(response.status).toBe(307);
      expect(location).toBe('https://admin.ai-video.internal/users?query=member&notice=sensitive-query-removed');
      expect(location).not.toContain('13800138000');
    } finally {
      delete process.env.ADMIN_SESSION_SIGNING_KEY;
    }
  });
});
