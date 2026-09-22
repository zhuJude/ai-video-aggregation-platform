/* eslint-disable @typescript-eslint/require-await -- the outermost upstream fetch is deliberately mocked. */
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
const serverHeaders = vi.hoisted(() => ({ sessionToken: '' }));
vi.mock('next/headers', () => ({ cookies: async () => ({ get: (name: string) => name === '__Host-admin_session' && serverHeaders.sessionToken ? { value: serverHeaders.sessionToken } : undefined }) }));

import { renderSecureLayout } from '../app/(secure)/layout';
import { renderUsersPage } from '../app/(secure)/users/page';
import { signAdminSession } from '../lib/session-auth';

const sessionSigningKey = 'integration-session-signing-key-at-least-32-bytes';
const descriptorSigningKey = 'integration-descriptor-signing-key-at-least-32-bytes';
const subjectId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const row = { displayName: '组合测试用户', id: '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f', phoneMasked: '138****8000', status: 'ACTIVE' };
const sessionInstanceId = '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f';

beforeEach(() => {
  process.env.ADMIN_OPERATIONS_API_URL = 'https://operations.example.invalid';
  process.env.ADMIN_OPERATIONS_KMS_IDENTITY_REF = 'kms://admin/integration';
  process.env.ADMIN_SESSION_SIGNING_KEY = sessionSigningKey;
  process.env.ADMIN_EXACT_PHONE_DESCRIPTOR_SIGNING_KEY = descriptorSigningKey;
});

afterEach(() => {
  vi.unstubAllGlobals();
  serverHeaders.sessionToken = '';
  delete process.env.ADMIN_OPERATIONS_API_URL;
  delete process.env.ADMIN_OPERATIONS_KMS_IDENTITY_REF;
  delete process.env.ADMIN_SESSION_SIGNING_KEY;
  delete process.env.ADMIN_EXACT_PHONE_DESCRIPTOR_SIGNING_KEY;
});

describe('production users route, shell, actions, and HTTP adapter integration', () => {
  it('fails closed on a phone-like upstream cursor before production markup or pagination', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [], nextCursor: 'cursor_13800138000' })));
    serverHeaders.sessionToken = await signAdminSession({ dataScope: 'OWN', expiresAt: Date.now() + 60_000, permissions: ['users:read'], sessionInstanceId, subjectId }, sessionSigningKey);
    const { container } = render(await renderSecureLayout(await renderUsersPage({ query: 'member' })));
    expect(screen.getByRole('alert')).toHaveTextContent('用户目录服务不可用');
    expect(screen.queryByRole('link', { name: '下一页' })).not.toBeInTheDocument();
    expect(container.innerHTML).not.toContain('13800138000');
  });

  it.each(['member-138/0013/8000', `member-138\u200b0013\u200b8000`, 'member-x%ZZ%31%33%38%30%30%31%33%38%30%30%30', 'member-١٣٨٠٠١٣٨٠٠٠'])(
    'fails closed from the real HTTP response through loader to production DOM for %s',
    async (displayName) => {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ items: [{ ...row, displayName }], nextCursor: null })));
      serverHeaders.sessionToken = await signAdminSession({ dataScope: 'OWN', expiresAt: Date.now() + 60_000, permissions: ['users:read'], sessionInstanceId, subjectId }, sessionSigningKey);
      const { container } = render(await renderSecureLayout(await renderUsersPage({ query: 'member' })));
      expect(screen.getByRole('alert')).toHaveTextContent('用户目录服务不可用');
      expect(screen.queryByRole('link', { name: displayName })).not.toBeInTheDocument();
      expect(container.textContent).not.toContain(displayName);
    },
  );

  it('sanitizes every browser parameter before production markup, hrefs, or the directory GET', async () => {
    const urls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      urls.push(input instanceof Request ? input.url : input instanceof URL ? input.href : input);
      return Response.json({ items: [], nextCursor: null });
    };
    vi.stubGlobal('fetch', fetchImpl);
    serverHeaders.sessionToken = await signAdminSession({ dataScope: 'OWN', expiresAt: Date.now() + 60_000, permissions: ['users:read'], sessionInstanceId, subjectId }, sessionSigningKey);
    const page = await renderUsersPage({ cursor: 'cursor-13800138000', future: '１３８００１３８０００', query: 'safe-member' });
    const { container } = render(await renderSecureLayout(page));
    expect(screen.getByRole('alert')).toHaveTextContent('敏感查询参数已移除');
    expect(container.innerHTML).not.toMatch(/13800138000|１３８００１３８０００/u);
    for (const anchor of container.querySelectorAll('a')) expect(anchor.getAttribute('href')).not.toMatch(/13800138000|１３８００１３８０００/u);
    expect(urls).toEqual(['https://operations.example.invalid/v1/admin/users?query=safe-member']);
  });

  it('keeps plaintext phone inside only the authorized exact lookup POST body', async () => {
    const now = Date.now();
    const requests: Readonly<{ body?: string; headers: Headers; method: string; url: string }>[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = input instanceof Request ? input.url : input instanceof URL ? input.href : input; const method = init?.method ?? 'GET'; const body = typeof init?.body === 'string' ? init.body : undefined;
      requests.push({ ...(body ? { body } : {}), headers: new Headers(init?.headers), method, url });
      if (url.includes('/exact-phone-lookups')) return Response.json({ expiresAt: new Date(now + 60_000).toISOString(), items: [row], searchHandle: 'internal_exact_handle_1234567890' });
      if (url.includes('/csv-export-requests')) return Response.json({ auditRecordId: '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f', downloadUrl: 'https://download.example.invalid/exact.csv', expiresAt: new Date(now + 60_000).toISOString() });
      return Response.json({ items: [row], nextCursor: 'safe-next-page' });
    };
    vi.stubGlobal('fetch', fetchImpl);
    serverHeaders.sessionToken = await signAdminSession({ dataScope: 'ASSIGNED', expiresAt: Date.now() + 60_000, permissions: ['users:read', 'users:phone-exact', 'users:export'], sessionInstanceId, subjectId }, sessionSigningKey);
    const usersPage = await renderUsersPage({ query: 'member' });
    const { container } = render(await renderSecureLayout(usersPage));

    expect(screen.getByTestId('admin-shell')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '下一页' })).toHaveAttribute('href', '/users?query=member&cursor=safe-next-page');
    expect(container.innerHTML).toContain('138****8000');
    expect(container.innerHTML).not.toContain('13800138000');

    const exact = screen.getByRole('region', { name: '受保护的精确手机号查询' });
    fireEvent.change(within(exact).getByRole('textbox', { name: '精确手机号' }), { target: { value: '13800138000' } });
    fireEvent.click(within(exact).getByRole('button', { name: '受保护查询' }));
    await within(exact).findByRole('table', { name: '精确手机号查询结果' });
    expect(within(exact).getByRole('textbox', { name: '精确手机号' })).toHaveValue('');
    expect(container.innerHTML).not.toContain('13800138000');

    fireEvent.change(within(exact).getByLabelText('导出原因'), { target: { value: '合规核对' } });
    fireEvent.click(within(exact).getByRole('checkbox', { name: '我确认这是高风险数据导出' }));
    serverHeaders.sessionToken = await signAdminSession({ dataScope: 'ASSIGNED', expiresAt: Date.now() + 60_000, permissions: ['users:read', 'users:phone-exact', 'users:export'], sessionInstanceId: '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f', subjectId }, sessionSigningKey);
    fireEvent.click(within(exact).getByRole('button', { name: '导出 CSV' }));
    await within(exact).findByText(/导出申请被拒绝或暂时不可用/u);
    expect(requests).toHaveLength(2);
    serverHeaders.sessionToken = await signAdminSession({ dataScope: 'ASSIGNED', expiresAt: Date.now() + 60_000, permissions: ['users:read', 'users:phone-exact', 'users:export'], sessionInstanceId, subjectId }, sessionSigningKey);
    fireEvent.click(within(exact).getByRole('button', { name: '导出 CSV' }));
    await within(exact).findByText(/导出已授权/u);

    await waitFor(() => { expect(requests).toHaveLength(3); });
    const [directoryRequest, exactRequest, exportRequest] = requests;
    expect(directoryRequest).toMatchObject({ method: 'GET', url: 'https://operations.example.invalid/v1/admin/users?query=member' });
    expect(exactRequest).toMatchObject({ method: 'POST', url: 'https://operations.example.invalid/v1/admin/users/exact-phone-lookups', body: JSON.stringify({ phone: '13800138000', scope: 'ASSIGNED' }) });
    expect(exportRequest?.url).not.toContain('13800138000');
    expect(JSON.parse(exportRequest?.body ?? '{}')).toMatchObject({ searchHandle: 'internal_exact_handle_1234567890', scope: 'ASSIGNED' });
    expect(exportRequest?.body).not.toContain('13800138000');
    expect(exportRequest?.body).not.toContain('searchDescriptor');
    for (const request of requests) {
      expect(request.headers.get('X-Trace-Id')).toMatch(/^[0-9a-f]{32}$/u);
      expect(request.headers.get('X-Correlation-Id')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
    }
  });
});
