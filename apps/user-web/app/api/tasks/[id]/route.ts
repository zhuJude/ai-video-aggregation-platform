import {
  AuthenticationRequiredError,
  SessionRefreshRequiredError,
  authenticatedGatewayFetch,
  requireAuthenticatedServerSession,
} from '../../../../lib/auth/server-session';
import { createMockTaskPollResponse } from '../../../../lib/tasks/mock-transport';
import { parseTaskDetail } from '../../../../lib/tasks/runtime';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly id: string }> },
): Promise<Response> {
  try {
    const { id } = await context.params;
    if (process.env.USER_WEB_STUDIO_MODE === 'mock') {
      const session = await requireAuthenticatedServerSession();
      return await createMockTaskPollResponse(session.ownerId, id);
    }
    const headers = new Headers();
    for (const name of ['x-trace-id', 'x-correlation-id'] as const) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
    const upstream = await authenticatedGatewayFetch(`/v1/tasks/${encodeURIComponent(id)}`, {
      headers,
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
    if (!upstream.ok) {
      await upstream.body?.cancel().catch(() => undefined);
      return new Response(null, { status: upstream.status });
    }
    const detail = parseTaskDetail((await upstream.json()) as unknown);
    return Response.json({ statusSnapshot: detail.statusSnapshot });
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      return Response.json({ code: 'SESSION_REFRESH_REQUIRED' }, { status: 401 });
    }
    return new Response(null, { status: error instanceof AuthenticationRequiredError ? 401 : 502 });
  }
}
