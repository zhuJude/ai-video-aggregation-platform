import {
  readAuthenticatedServerSessionState,
  refreshAuthenticatedServerSession,
} from '../../../lib/auth/server-session';

export async function GET(request: Request): Promise<Response> {
  const fetchSite = request.headers.get('sec-fetch-site');
  if (fetchSite !== 'same-origin') {
    return new Response(null, { status: 403 });
  }
  const state = await readAuthenticatedServerSessionState();
  return state.kind === 'active'
    ? new Response(null, { status: 204 })
    : Response.json(
        { code: state.kind === 'needs-refresh' ? 'SESSION_REFRESH_REQUIRED' : 'UNAUTHENTICATED' },
        { status: 401 },
      );
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin !== url.origin || (fetchSite !== null && fetchSite !== 'same-origin')) {
    return new Response(null, { status: 403 });
  }
  return (await refreshAuthenticatedServerSession())
    ? new Response(null, { status: 204 })
    : new Response(null, { status: 401 });
}
