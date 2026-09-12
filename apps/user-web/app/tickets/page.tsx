import Link from 'next/link';
import { redirect } from 'next/navigation';

import { TicketCenter } from '../../components/support/ticket-center';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { supportGateway } from '../../lib/support/gateway';
import { parseTicketFilters, parseTicketPage } from '../../lib/support/runtime';

export default async function TicketsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'needs-refresh') redirect('/auth/session/refresh?returnTo=%2Ftickets');
  if (state.kind !== 'active') redirect('/login?returnTo=%2Ftickets');
  try {
    const filters = parseTicketFilters(await searchParams);
    const page = parseTicketPage(
      await supportGateway.listTickets(filters, { ownerId: state.session.ownerId }),
    );
    const href = (cursor: string) => {
      const params = new URLSearchParams();
      if (filters.status) params.set('status', filters.status);
      params.set('cursor', cursor);
      return `/tickets?${params.toString()}`;
    };
    return (
      <div className="support-page">
        <form className="commerce-filter-panel" method="get">
          <label htmlFor="ticket-status">
            工单状态
            <select id="ticket-status" name="status" defaultValue={filters.status ?? ''}>
              <option value="">全部</option>
              <option value="OPEN">待处理</option>
              <option value="IN_PROGRESS">处理中</option>
              <option value="RESOLVED">已解决</option>
              <option value="CLOSED">已关闭</option>
            </select>
          </label>
          <button type="submit">应用筛选</button>
        </form>
        <TicketCenter initial={page} />
        <nav className="cursor-nav" aria-label="工单翻页">
          {page.pageInfo.previousCursor ? (
            <Link href={href(page.pageInfo.previousCursor)}>上一页</Link>
          ) : (
            <span />
          )}
          {page.pageInfo.nextCursor ? (
            <Link href={href(page.pageInfo.nextCursor)}>下一页</Link>
          ) : null}
        </nav>
      </div>
    );
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <p className="section-kicker">客户支持</p>
        <h1>暂时无法加载工单</h1>
        <p>响应未通过安全校验或服务暂不可用。</p>
        <a href="/tickets">重新加载</a>
      </section>
    );
  }
}
