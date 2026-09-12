export const dynamic = 'force-dynamic';

function configurationReady(): boolean {
  const gateway = process.env.GATEWAY_URL?.trim();
  const sessionKey = process.env.USER_WEB_SESSION_ENCRYPTION_KEY;
  if (!gateway || !sessionKey || !/^[A-Za-z0-9_-]{43}$/.test(sessionKey)) return false;
  try {
    const parsed = new URL(gateway);
    return (
      parsed.protocol === 'https:' ||
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1'
    );
  } catch {
    return false;
  }
}

export function GET(): Response {
  const ready = configurationReady();
  return Response.json(
    { status: ready ? 'ready' : 'unavailable' },
    {
      headers: { 'cache-control': 'no-store' },
      status: ready ? 200 : 503,
    },
  );
}
