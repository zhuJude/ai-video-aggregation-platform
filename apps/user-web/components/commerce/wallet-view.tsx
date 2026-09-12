import Link from 'next/link';

import { formatChinaDate, formatPoints } from '../../lib/commerce/runtime';
import type { WalletFilters, WalletPage } from '../../lib/commerce/types';
import { WalletSummary } from './wallet-summary';

const labels = {
  RECHARGE: '充值入账',
  RESERVE: '任务冻结',
  SETTLE: '任务结算',
  RELEASE: '释放冻结',
  REFUND: '任务退款',
  ADJUST: '账户调整',
} as const;

export function WalletView({
  page,
  filters,
}: {
  readonly page: WalletPage;
  readonly filters: WalletFilters;
}) {
  const pageHref = (cursor: string) => {
    const params = new URLSearchParams();
    if (filters.type) params.set('type', filters.type);
    params.set('cursor', cursor);
    return `/wallet?${params.toString()}`;
  };
  return (
    <div className="commerce-page">
      <header className="commerce-heading">
        <div>
          <p className="section-kicker">点数钱包</p>
          <h1>每一笔点数，都有明确去向</h1>
          <p>余额与不可变总账来自同一账户事实；所有时间均按中国标准时间显示。</p>
        </div>
        <Link className="button-link button-primary" href="/orders">
          充值点数
        </Link>
      </header>
      <WalletSummary balance={page.balance} />
      <section className="commerce-section" aria-labelledby="ledger-title">
        <div className="commerce-section-heading">
          <div>
            <p className="section-kicker">不可变总账</p>
            <h2 id="ledger-title">交易流水</h2>
          </div>
          <form className="compact-filter" method="get">
            <label htmlFor="wallet-type">交易类型</label>
            <select id="wallet-type" name="type" defaultValue={filters.type ?? ''}>
              <option value="">全部</option>
              {Object.entries(labels).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button type="submit">筛选</button>
          </form>
        </div>
        {page.transactions.length === 0 ? (
          <div className="commerce-empty" role="status">
            <h3>暂无匹配流水</h3>
            <p>新的充值或任务变动会显示在这里。</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="commerce-table">
              <thead>
                <tr>
                  <th>类型</th>
                  <th>方向</th>
                  <th>点数</th>
                  <th>关联</th>
                  <th>入账时间</th>
                </tr>
              </thead>
              <tbody>
                {page.transactions.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <strong>{labels[item.type]}</strong>
                      <small>已入账 · 不可修改</small>
                    </td>
                    <td>
                      {item.direction === 'CREDIT'
                        ? '入账'
                        : item.direction === 'DEBIT'
                          ? '扣减'
                          : '账户内转移'}
                    </td>
                    <td className="numeric">
                      {item.direction === 'DEBIT' ? '−' : item.direction === 'CREDIT' ? '+' : ''}
                      {formatPoints(item.points)}
                    </td>
                    <td>
                      {item.reference ? (
                        <Link
                          href={
                            item.reference.kind === 'TASK'
                              ? `/tasks/${encodeURIComponent(item.reference.id)}`
                              : `/orders?order=${encodeURIComponent(item.reference.id)}`
                          }
                        >
                          {item.reference.label}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      <time dateTime={item.occurredAt}>{formatChinaDate(item.occurredAt)}</time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <nav className="cursor-nav" aria-label="钱包流水翻页">
          {page.pageInfo.previousCursor ? (
            <Link href={pageHref(page.pageInfo.previousCursor)}>上一页</Link>
          ) : (
            <span />
          )}
          {page.pageInfo.nextCursor ? (
            <Link href={pageHref(page.pageInfo.nextCursor)}>下一页</Link>
          ) : null}
        </nav>
      </section>
    </div>
  );
}
