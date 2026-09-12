import { redirect } from 'next/navigation';

import { InvoiceCenter } from '../../components/commerce/invoice-center';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { commerceGateway } from '../../lib/commerce/gateway';
import { commerceOwnerIdFromPhone } from '../../lib/commerce/identity';
import { parseInvoiceCandidatePage } from '../../lib/commerce/runtime';

export default async function InvoicesPage() {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'needs-refresh') redirect('/auth/session/refresh?returnTo=%2Finvoices');
  if (state.kind !== 'active') redirect('/login?returnTo=%2Finvoices');
  try {
    const page = parseInvoiceCandidatePage(
      await commerceGateway.listInvoiceCandidates({
        ownerId: commerceOwnerIdFromPhone(state.session.ownerId),
      }),
    );
    return (
      <div className="commerce-page">
        <header className="commerce-heading">
          <div>
            <p className="section-kicker">发票</p>
            <h1>从已支付金额发起申请</h1>
            <p>平台保留资格核验和状态历史；当前不集成第三方电子税务开票 API。</p>
          </div>
          <a className="button-link button-secondary" href="/orders">
            查看充值订单
          </a>
        </header>
        <InvoiceCenter initial={page} />
      </div>
    );
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <p className="section-kicker">发票</p>
        <h1>暂时无法加载发票信息</h1>
        <p>未通过资格或响应校验的金额不会显示。</p>
        <a className="button-link button-secondary" href="/invoices">
          重新加载
        </a>
      </section>
    );
  }
}
