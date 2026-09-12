import Link from 'next/link';
import { redirect } from 'next/navigation';

import { MessageCenter } from '../../components/support/message-center';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { supportGateway } from '../../lib/support/gateway';
import { parseMessageFilters, parseMessagePage } from '../../lib/support/runtime';

export default async function MessagesPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'needs-refresh') redirect('/auth/session/refresh?returnTo=%2Fmessages');
  if (state.kind !== 'active') redirect('/login?returnTo=%2Fmessages');
  try {
    const filters = parseMessageFilters(await searchParams);
    const page = parseMessagePage(
      await supportGateway.listMessages(filters, { ownerId: state.session.ownerId }),
    );
    const href = (cursor: string) => {
      const params = new URLSearchParams();
      if (filters.state) params.set('state', filters.state);
      if (filters.kind) params.set('kind', filters.kind);
      params.set('cursor', cursor);
      return `/messages?${params.toString()}`;
    };
    return (
      <div className="support-page">
        <form className="commerce-filter-panel" method="get">
          <label htmlFor="message-state">
            阅读状态
            <select id="message-state" name="state" defaultValue={filters.state ?? 'ALL'}>
              <option value="ALL">全部</option>
              <option value="UNREAD">仅未读</option>
            </select>
          </label>
          <label htmlFor="message-kind">
            消息类型
            <select id="message-kind" name="kind" defaultValue={filters.kind ?? ''}>
              <option value="">全部</option>
              <option value="TASK">任务</option>
              <option value="PAYMENT">支付</option>
              <option value="BALANCE">余额</option>
              <option value="SYSTEM">系统</option>
            </select>
          </label>
          <button type="submit">应用筛选</button>
        </form>
        <MessageCenter initial={page} />
        <nav className="cursor-nav" aria-label="消息翻页">
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
        <p className="section-kicker">通知中心</p>
        <h1>暂时无法加载消息</h1>
        <p>响应未通过安全校验或服务暂不可用。</p>
        <a href="/messages">重新加载</a>
      </section>
    );
  }
}
