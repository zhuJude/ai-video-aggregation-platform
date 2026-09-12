import { redirect } from 'next/navigation';

import { OrderCenter } from '../../components/commerce/order-center';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { commerceGateway } from '../../lib/commerce/gateway';
import { parseOrderPage } from '../../lib/commerce/runtime';
import type { RechargeOrderStatus } from '../../lib/commerce/types';

const statuses = new Set<RechargeOrderStatus>(['PENDING', 'PAID', 'CLOSED', 'REFUNDED', 'FAILED']);

export default async function OrdersPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'needs-refresh') redirect('/auth/session/refresh?returnTo=%2Forders');
  if (state.kind !== 'active') redirect('/login?returnTo=%2Forders');
  try {
    const raw = await searchParams;
    const cursor = typeof raw.cursor === 'string' && raw.cursor ? raw.cursor : undefined;
    const status = typeof raw.status === 'string' && raw.status ? raw.status : undefined;
    if (status && !statuses.has(status as RechargeOrderStatus))
      throw new Error('INVALID_ORDER_FILTER');
    const page = parseOrderPage(
      await commerceGateway.listOrders(
        {
          ...(cursor ? { cursor } : {}),
          ...(status ? { status: status as RechargeOrderStatus } : {}),
        },
        { ownerId: state.session.ownerId },
      ),
    );
    return (
      <div className="commerce-page">
        <header className="commerce-heading">
          <div>
            <p className="section-kicker">充值与订单</p>
            <h1>按需购买，清楚核对</h1>
            <p>创建订单后再进入微信支付；待处理期间会锁定提交，网络结果未知时先核对订单。</p>
          </div>
          <a className="button-link button-secondary" href="/wallet">
            查看钱包
          </a>
        </header>
        <OrderCenter initial={page} />
      </div>
    );
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <p className="section-kicker">充值订单</p>
        <h1>暂时无法加载订单</h1>
        <p>请检查筛选条件或稍后重试。</p>
        <a className="button-link button-secondary" href="/orders">
          重新加载
        </a>
      </section>
    );
  }
}
