import { SessionRefreshTrampoline } from '../../../../components/auth/session-refresh-trampoline';
import { safeReturnTo } from '../../../../lib/auth/safe-return-to';

export default async function SessionRefreshPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return <SessionRefreshTrampoline returnTo={safeReturnTo(params.returnTo)} />;
}
