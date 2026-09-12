import { refreshAuthenticatedServerSession } from '../../../lib/auth/server-session';

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
