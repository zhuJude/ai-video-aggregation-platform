import {
  AuthenticationRequiredError,
  authenticatedGatewayFetch,
} from '../../../../../lib/auth/server-session';
import { isTaskEventCursor } from '../../../../../lib/tasks/identifiers';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const headers = new Headers({ accept: 'text/event-stream' });
    const cursor = request.headers.get('last-event-id');
    if (cursor !== null) {
      if (!isTaskEventCursor(cursor)) return new Response(null, { status: 400 });
      headers.set('last-event-id', cursor);
    }
    for (const name of ['x-trace-id', 'x-correlation-id'] as const) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await authenticatedGatewayFetch(`/v1/tasks/${encodeURIComponent(id)}/events`, {
      headers,
      signal: request.signal,
    });
    if (!upstream.ok) return new Response(null, { status: upstream.status });
    const contentType = upstream.headers.get('content-type');
    if (!contentType?.includes('text/event-stream') || !upstream.body) {
      upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: 502 });
    }
    const responseHeaders = new Headers({
      'cache-control': 'no-cache, no-store, must-revalidate',
      'content-type': contentType,
      'x-accel-buffering': 'no',
    });
    for (const name of ['x-trace-id', 'x-correlation-id'] as const) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders.set(name, value);
    }
    return new Response(upstream.body, { headers: responseHeaders });
  } catch (error) {
    return new Response(null, { status: error instanceof AuthenticationRequiredError ? 401 : 502 });
  }
}
