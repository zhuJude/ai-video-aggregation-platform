import { type NextRequest, NextResponse } from 'next/server';

import { hasPermission } from './lib/permissions';
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from './lib/session-auth';
import {
  containsSensitivePhoneLikeValue,
  sanitizeUsersSearchParams,
  SENSITIVE_QUERY_NOTICE,
  usersSearchParamsToString,
} from './lib/sensitive-query';
import { isUtcIso8601Z } from './lib/frozen-scalars';
import { isUuidV7 } from './lib/uuid-v7';

const routePermissions: Readonly<Record<string, string>> = {
  overview: 'overview:read',
  users: 'users:read',
  providers: 'providers:read',
  models: 'models:read',
  pricing: 'pricing:read',
  routing: 'routing:read',
  tasks: 'tasks:read',
  finance: 'finance:read',
  content: 'content:read',
  tickets: 'tickets:read',
  iam: 'iam:read',
  audit: 'audit:read',
  system: 'system:read',
};

function requiredPermission(pathname: string): string | undefined {
  const firstSegment = pathname.split('/').find(Boolean);
  return firstSegment ? routePermissions[firstSegment] : undefined;
}

type SearchRule = (value: string) => boolean;

const safeSearchText =
  (maximum: number): SearchRule =>
  (value) =>
    value.length > 0 && value.length <= maximum && !/[\p{C}]/u.test(value);
const cursorRule: SearchRule = (value) =>
  value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,255}$/u.test(value);
const traceRule: SearchRule = (value) => /^[0-9a-f]{32}$/iu.test(value);
const enumRule =
  (values: readonly string[]): SearchRule =>
  (value) =>
    values.includes(value);

const declaredSearchRules: Readonly<Record<string, Readonly<Record<string, SearchRule>>>> = {
  '/audit': {
    action: safeSearchText(128),
    actor: safeSearchText(128),
    cursor: cursorRule,
    from: isUtcIso8601Z,
    resource: safeSearchText(128),
    to: isUtcIso8601Z,
    traceId: traceRule,
  },
  '/content': {
    cursor: cursorRule,
    status: enumRule(['DRAFT', 'DRAFT_VALIDATED', 'PUBLISHED']),
  },
  '/finance/invoices': {
    cursor: cursorRule,
    query: safeSearchText(160),
    status: enumRule(['APPLIED', 'APPROVED', 'REJECTED', 'ISSUED']),
  },
  '/finance/ledger': { cursor: cursorRule, query: safeSearchText(160) },
  '/finance/orders': {
    cursor: cursorRule,
    query: safeSearchText(160),
    status: enumRule(['PENDING', 'PAID', 'REFUNDING', 'REFUNDED', 'FAILED']),
  },
  '/finance/reconciliation': {
    category: enumRule(['PLATFORM_ONLY', 'CHANNEL_ONLY', 'AMOUNT_MISMATCH', 'STATUS_MISMATCH']),
    cursor: cursorRule,
    status: enumRule(['OPEN', 'INVESTIGATING', 'REPAIRED', 'IGNORED']),
  },
  '/tasks': {
    cursor: cursorRule,
    query: safeSearchText(160),
    status: enumRule(['QUEUED', 'PROVIDER_PENDING', 'FAILED', 'SUCCEEDED']),
  },
  '/tickets': {
    cursor: cursorRule,
    query: safeSearchText(160),
    status: enumRule(['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED']),
  },
};

function declaredSearch(pathname: string, params: URLSearchParams): string {
  const rules = declaredSearchRules[pathname];
  if (!rules || containsSensitivePhoneLikeValue(params.toString())) return '';
  const sanitized = new URLSearchParams();
  for (const [key, rule] of Object.entries(rules)) {
    const values = params.getAll(key);
    if (values.length === 1 && rule(values[0] ?? '')) sanitized.set(key, values[0] ?? '');
  }
  return sanitized.toString();
}

type CanonicalPath = Readonly<{
  kind: 'OTHER' | 'USER_DETAIL' | 'USERS';
  pathname: string;
  rejected: boolean;
}>;

function canonicalPathname(pathname: string): CanonicalPath {
  if (pathname === '/users' || pathname === '/users/')
    return { kind: 'USERS', pathname: '/users', rejected: false };
  if (pathname.startsWith('/users/') || pathname.startsWith('/users%')) {
    const match = /^\/users\/([^/]+)\/?$/u.exec(pathname);
    const userId = match?.[1];
    if (userId && !userId.includes('%') && isUuidV7(userId)) {
      return { kind: 'USER_DETAIL', pathname: `/users/${userId}`, rejected: false };
    }
    return { kind: 'USERS', pathname: '/users', rejected: true };
  }
  if (containsSensitivePhoneLikeValue(pathname))
    return { kind: 'OTHER', pathname: '/login', rejected: true };
  return { kind: 'OTHER', pathname, rejected: false };
}

function safeReturnLocation(request: NextRequest): string | undefined {
  const canonical = canonicalPathname(request.nextUrl.pathname);
  if (
    canonical.rejected ||
    canonical.pathname !== request.nextUrl.pathname ||
    !requiredPermission(canonical.pathname)
  )
    return undefined;
  if (containsSensitivePhoneLikeValue(request.nextUrl.search)) return undefined;
  if (canonical.kind === 'USERS') {
    const search = usersSearchParamsToString(
      sanitizeUsersSearchParams(request.nextUrl.searchParams).params,
    );
    return `${canonical.pathname}${search ? `?${search}` : ''}`;
  }
  const search = declaredSearch(canonical.pathname, request.nextUrl.searchParams);
  return `${canonical.pathname}${search ? `?${search}` : ''}`;
}

function loginRedirect(request: NextRequest): NextResponse {
  const loginUrl = new URL('/login', request.url);
  const next = safeReturnLocation(request);
  if (next) loginUrl.searchParams.set('next', next);
  return NextResponse.redirect(loginUrl);
}

function safeLoginNext(value: string | null, request: NextRequest): string | undefined {
  if (!value || value.length > 2048 || value.startsWith('//')) return undefined;
  try {
    const nested = new URL(value, request.nextUrl.origin);
    if (nested.origin !== request.nextUrl.origin || nested.pathname === '/login') return undefined;
    const canonical = canonicalPathname(nested.pathname);
    if (canonical.rejected || !requiredPermission(canonical.pathname)) return undefined;
    if (canonical.kind === 'USERS') {
      const sanitized = sanitizeUsersSearchParams(nested.searchParams);
      if (sanitized.rejected) return undefined;
      const search = usersSearchParamsToString(sanitized.params);
      return `${canonical.pathname}${search ? `?${search}` : ''}`;
    }
    const search = declaredSearch(canonical.pathname, nested.searchParams);
    if (new URLSearchParams(search).size !== nested.searchParams.size) return undefined;
    return `${canonical.pathname}${search ? `?${search}` : ''}`;
  } catch {
    return undefined;
  }
}

function canonicalSearchRedirect(request: NextRequest): NextResponse | undefined {
  const canonical = canonicalPathname(request.nextUrl.pathname);
  let search: string;
  if (canonical.kind === 'USERS') {
    const sanitized = sanitizeUsersSearchParams(request.nextUrl.searchParams);
    search = usersSearchParamsToString({
      ...sanitized.params,
      ...(canonical.rejected || sanitized.rejected ? { notice: SENSITIVE_QUERY_NOTICE } : {}),
    });
  } else if (canonical.pathname === '/login') {
    const values = request.nextUrl.searchParams.getAll('next');
    const next =
      !canonical.rejected && values.length === 1
        ? safeLoginNext(values[0] ?? null, request)
        : undefined;
    search = next ? new URLSearchParams({ next }).toString() : '';
  } else {
    search = declaredSearch(canonical.pathname, request.nextUrl.searchParams);
  }
  const current = request.nextUrl.searchParams.toString();
  if (request.nextUrl.pathname === canonical.pathname && current === search) return undefined;
  const canonicalUrl = new URL(canonical.pathname, request.url);
  canonicalUrl.search = search;
  return NextResponse.redirect(canonicalUrl);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const canonicalRedirect = canonicalSearchRedirect(request);
  if (canonicalRedirect) return canonicalRedirect;

  if (request.nextUrl.pathname === '/login') {
    return NextResponse.next();
  }

  const claims = await verifyAdminSession(
    request.cookies.get(ADMIN_SESSION_COOKIE)?.value,
    process.env.ADMIN_SESSION_SIGNING_KEY,
  );
  if (!claims) {
    return loginRedirect(request);
  }

  const permission = requiredPermission(request.nextUrl.pathname);
  if (!permission) {
    return NextResponse.json(
      { error: 'NOT_FOUND' },
      { headers: { 'Cache-Control': 'no-store' }, status: 404 },
    );
  }

  if (!hasPermission(claims, permission)) {
    return NextResponse.json(
      { error: 'FORBIDDEN' },
      { headers: { 'Cache-Control': 'no-store' }, status: 403 },
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
