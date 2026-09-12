import { redirect } from 'next/navigation';

import { WalletView } from '../../components/commerce/wallet-view';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { commerceGateway } from '../../lib/commerce/gateway';
import { parseWalletFilters, parseWalletPage } from '../../lib/commerce/runtime';

export default async function WalletPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'needs-refresh') redirect('/auth/session/refresh?returnTo=%2Fwallet');
  if (state.kind !== 'active') redirect('/login?returnTo=%2Fwallet');
  try {
    const filters = parseWalletFilters(await searchParams);
    const page = parseWalletPage(
      await commerceGateway.getWallet(filters, {
        ownerId: state.session.ownerId,
      }),
    );
    return <WalletView page={page} filters={filters} />;
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <p className="section-kicker">点数钱包</p>
        <h1>暂时无法加载钱包</h1>
        <p>为了保护账务准确性，未通过校验的数据不会显示。</p>
        <a className="button-link button-secondary" href="/wallet">
          重新加载
        </a>
      </section>
    );
  }
}
