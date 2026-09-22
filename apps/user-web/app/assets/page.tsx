import Link from 'next/link';
import { redirect } from 'next/navigation';

import { AssetLibrary } from '../../components/commerce/asset-library';
import { readAuthenticatedServerSessionState } from '../../lib/auth/server-session';
import { commerceGateway } from '../../lib/commerce/gateway';
import { parseAssetFilters, parseAssetPage } from '../../lib/commerce/runtime';

export default async function AssetsPage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'needs-refresh') redirect('/auth/session/refresh?returnTo=%2Fassets');
  if (state.kind !== 'active') redirect('/login?returnTo=%2Fassets');
  try {
    const filters = parseAssetFilters(await searchParams);
    const page = parseAssetPage(
      await commerceGateway.listAssets(filters, {
        ownerId: state.session.ownerId,
      }),
    );
    const pageHref = (cursor: string) => {
      const params = new URLSearchParams();
      if (filters.kind) params.set('kind', filters.kind);
      if (filters.mediaType) params.set('mediaType', filters.mediaType);
      if (filters.query) params.set('query', filters.query);
      params.set('cursor', cursor);
      return `/assets?${params.toString()}`;
    };
    return (
      <div className="commerce-page">
        <header className="commerce-heading">
          <div>
            <p className="section-kicker">作品与素材</p>
            <h1>你的私人创作档案</h1>
            <p>预览与下载链接仅在需要时签发并短时有效，不会保存到页面数据中。</p>
          </div>
          <Link className="button-link button-secondary" href="/studio">
            使用素材生成
          </Link>
        </header>
        <form className="commerce-filter-panel" method="get">
          <label htmlFor="asset-query">
            搜索名称
            <input id="asset-query" name="query" defaultValue={filters.query ?? ''} />
          </label>
          <label htmlFor="asset-kind">
            内容来源
            <select id="asset-kind" name="kind" defaultValue={filters.kind ?? ''}>
              <option value="">全部</option>
              <option value="RESULT">生成作品</option>
              <option value="UPLOAD">上传素材</option>
            </select>
          </label>
          <label htmlFor="asset-media">
            文件类型
            <select id="asset-media" name="mediaType" defaultValue={filters.mediaType ?? ''}>
              <option value="">全部</option>
              <option value="VIDEO">视频</option>
              <option value="IMAGE">图片</option>
            </select>
          </label>
          <button type="submit">应用筛选</button>
        </form>
        <AssetLibrary initial={page} />
        <nav className="cursor-nav" aria-label="素材翻页">
          {page.pageInfo.previousCursor ? (
            <Link href={pageHref(page.pageInfo.previousCursor)}>上一页</Link>
          ) : (
            <span />
          )}
          {page.pageInfo.nextCursor ? (
            <Link href={pageHref(page.pageInfo.nextCursor)}>下一页</Link>
          ) : null}
        </nav>
      </div>
    );
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <p className="section-kicker">作品与素材</p>
        <h1>暂时无法加载素材</h1>
        <p>响应未通过安全校验或网络暂不可用，请重新加载。</p>
        <a className="button-link button-secondary" href="/assets">
          重新加载
        </a>
      </section>
    );
  }
}
