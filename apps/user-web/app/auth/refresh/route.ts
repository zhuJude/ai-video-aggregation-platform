import {
  readAuthenticatedServerSessionState,
  refreshAuthenticatedServerSession,
} from '../../../lib/auth/server-session';

const PRIVATE_NO_STORE_HEADERS = {
  'cache-control': 'no-store, private',
  pragma: 'no-cache',
  vary: 'Cookie',
} as const;

export async function GET(request: Request): Promise<Response> {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== 'same-origin') {
    return new Response(null, { headers: PRIVATE_NO_STORE_HEADERS, status: 403 });
  }
  const state = await readAuthenticatedServerSessionState();
  return state.kind === 'active'
    ? new Response(null, { headers: PRIVATE_NO_STORE_HEADERS, status: 204 })
    : Response.json(
        { code: state.kind === 'needs-refresh' ? 'SESSION_REFRESH_REQUIRED' : 'UNAUTHENTICATED' },
        { headers: PRIVATE_NO_STORE_HEADERS, status: 401 },
      );
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin !== url.origin || (fetchSite !== null && fetchSite !== 'same-origin')) {
    return new Response(null, { headers: PRIVATE_NO_STORE_HEADERS, status: 403 });
  }
  return (await refreshAuthenticatedServerSession())
    ? new Response(null, { headers: PRIVATE_NO_STORE_HEADERS, status: 204 })
    : new Response(null, { headers: PRIVATE_NO_STORE_HEADERS, status: 401 });
}
