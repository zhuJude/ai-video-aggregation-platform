import {
  AuthenticationRequiredError,
  authenticatedGatewayFetch,
} from '../../../../lib/auth/server-session';
import { parseTaskDetail } from '../../../../lib/tasks/runtime';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    const headers = new Headers();
    for (const name of ['x-trace-id', 'x-correlation-id'] as const) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await authenticatedGatewayFetch(`/v1/tasks/${encodeURIComponent(id)}`, {
      headers,
      signal: request.signal,
    });
    if (!upstream.ok) return new Response(null, { status: upstream.status });
    return Response.json(parseTaskDetail((await upstream.json()) as unknown));
  } catch (error) {
    return new Response(null, { status: error instanceof AuthenticationRequiredError ? 401 : 502 });
  }
}
