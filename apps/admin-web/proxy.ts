import { type NextRequest, NextResponse } from 'next/server';

import { hasPermission } from './lib/permissions';
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from './lib/session-auth';
import { containsSensitivePhoneLikeValue, sanitizeUsersSearchParams, SENSITIVE_QUERY_NOTICE, usersSearchParamsToString } from './lib/sensitive-query';
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

type CanonicalPath = Readonly<{ kind: 'OTHER' | 'USER_DETAIL' | 'USERS'; pathname: string; rejected: boolean }>;

function canonicalPathname(pathname: string): CanonicalPath {
  if (pathname === '/users' || pathname === '/users/') return { kind: 'USERS', pathname: '/users', rejected: false };
  if (pathname.startsWith('/users/') || pathname.startsWith('/users%')) {
    const match = /^\/users\/([^/]+)\/?$/u.exec(pathname);
    const userId = match?.[1];
    if (userId && !userId.includes('%') && isUuidV7(userId)) {
      return { kind: 'USER_DETAIL', pathname: `/users/${userId}`, rejected: false };
    }
    return { kind: 'USERS', pathname: '/users', rejected: true };
  }
  if (containsSensitivePhoneLikeValue(pathname)) return { kind: 'OTHER', pathname: '/login', rejected: true };
  return { kind: 'OTHER', pathname, rejected: false };
}

function safeReturnLocation(request: NextRequest): string | undefined {
  const canonical = canonicalPathname(request.nextUrl.pathname);
  if (canonical.rejected || canonical.pathname !== request.nextUrl.pathname || !requiredPermission(canonical.pathname)) return undefined;
  return containsSensitivePhoneLikeValue(request.nextUrl.search) ? undefined : `${canonical.pathname}${request.nextUrl.search}`;
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
    if (nested.search) return undefined;
    return canonical.pathname;
  } catch {
    return undefined;
  }
}

function canonicalSearchRedirect(request: NextRequest): NextResponse | undefined {
  const canonical = canonicalPathname(request.nextUrl.pathname);
  let search = '';
  if (canonical.kind === 'USERS') {
    const sanitized = sanitizeUsersSearchParams(request.nextUrl.searchParams);
    search = usersSearchParamsToString({ ...sanitized.params, ...((canonical.rejected || sanitized.rejected) ? { notice: SENSITIVE_QUERY_NOTICE } : {}) });
  } else if (canonical.pathname === '/login') {
    const values = request.nextUrl.searchParams.getAll('next');
    const next = !canonical.rejected && values.length === 1 ? safeLoginNext(values[0] ?? null, request) : undefined;
    search = next ? new URLSearchParams({ next }).toString() : '';
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
