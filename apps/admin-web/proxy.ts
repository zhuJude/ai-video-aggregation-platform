import { type NextRequest, NextResponse } from 'next/server';

import { hasPermission } from './lib/permissions';
import { ADMIN_SESSION_COOKIE, verifyAdminSession } from './lib/session-auth';

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

function loginRedirect(request: NextRequest): NextResponse {
  const loginUrl = new URL('/login', request.url);
  loginUrl.searchParams.set(
    'next',
    `${request.nextUrl.pathname}${request.nextUrl.search}`,
  );
  return NextResponse.redirect(loginUrl);
}

export async function proxy(request: NextRequest): Promise<NextResponse> {
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
