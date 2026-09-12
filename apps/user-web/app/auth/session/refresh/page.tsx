import { SessionRefreshTrampoline } from '../../../../components/auth/session-refresh-trampoline';

function safeReturnTo(input: string | string[] | undefined): string {
  if (typeof input !== 'string' || input.includes('\\')) return '/tasks';
  try {
    const parsed = new URL(input, 'https://app.invalid');
    if (
      parsed.origin !== 'https://app.invalid' ||
      parsed.hash ||
      !/^\/tasks(?:\/[A-Za-z0-9_-]+)?$/.test(parsed.pathname)
    ) {
      return '/tasks';
    }
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/tasks';
  }
}

export default async function SessionRefreshPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <SessionRefreshTrampoline returnTo={safeReturnTo(params.returnTo)} />;
}
