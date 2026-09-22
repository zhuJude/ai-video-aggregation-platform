import { identityVerificationConfigurationReady } from '../../lib/auth/server-session';

export const dynamic = 'force-dynamic';

const mockModeNames = [
  'USER_WEB_PUBLIC_MODE',
  'USER_WEB_STUDIO_MODE',
  'USER_WEB_COMMERCE_MODE',
  'USER_WEB_SUPPORT_MODE',
] as const;

function sessionKeyReady(): boolean {
  const encoded = process.env.USER_WEB_SESSION_ENCRYPTION_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) return false;
  const decoded = Buffer.from(encoded, 'base64url');
  return decoded.length === 32 && decoded.toString('base64url') === encoded;
}

function gatewayUrl(): URL | undefined {
  const configured = process.env.GATEWAY_URL?.trim();
  if (!configured) return undefined;
  try {
    const parsed = new URL(configured);
    if (
      parsed.protocol !== 'https:' &&
      parsed.hostname !== 'localhost' &&
      parsed.hostname !== '127.0.0.1'
    )
      return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function productionModesReady(): boolean {
  return (
    process.env.NODE_ENV !== 'production' ||
    mockModeNames.every((name) => process.env[name]?.trim().toLowerCase() !== 'mock')
  );
}

async function gatewayReachable(base: URL): Promise<boolean> {
  try {
    const response = await fetch(new URL('/health/ready', base), {
      cache: 'no-store',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
      await response.body?.cancel().catch(() => undefined);
      return false;
    }
    const body = (await response.json()) as unknown;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
    const source = body as Record<string, unknown>;
    if (Object.keys(source).some((key) => key !== 'ok' && key !== 'checks') || source.ok !== true)
      return false;
    if (typeof source.checks !== 'object' || source.checks === null || Array.isArray(source.checks))
      return false;
    const checks = Object.values(source.checks as Record<string, unknown>);
    return checks.length > 0 && checks.every((value) => value === true);
  } catch {
    return false;
  }
}

export async function GET(): Promise<Response> {
  const base = gatewayUrl();
  const ready =
    base !== undefined &&
    sessionKeyReady() &&
    identityVerificationConfigurationReady() &&
    productionModesReady() &&
    (await gatewayReachable(base));
  return Response.json(
    { status: ready ? 'ready' : 'unavailable' },
    {
      headers: { 'cache-control': 'no-store' },
      status: ready ? 200 : 503,
    },
  );
}
