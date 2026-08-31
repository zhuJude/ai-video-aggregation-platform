import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PublicErrorState, PublicPageShell } from '../../../components/public-page-shell';
import { publicSiteGateway } from '../../../lib/public-gateway';
import { sanitizePublishedHtml } from '../../../lib/sanitize-published-html';

interface HelpPageProps {
  params: Promise<{ slug?: string[] }>;
}

export async function generateMetadata({ params }: HelpPageProps): Promise<Metadata> {
  const { slug = [] } = await params;
  const result = await publicSiteGateway.getHelp(slug);
  if (!result.ok || !result.data.article) return { title: '帮助中心' };
  return {
    title: result.data.article.title,
    description: result.data.article.summary,
  };
}

export default async function HelpPage({ params }: HelpPageProps) {
  const { slug = [] } = await params;
  const result = await publicSiteGateway.getHelp(slug);

  if (!result.ok) {
    return (
      <PublicPageShell>
        <PublicErrorState />
      </PublicPageShell>
    );
  }
  if (!result.data.article) notFound();

  const article = result.data.article;
  const safePublishedHtml = sanitizePublishedHtml(article.publishedHtml);

  return (
    <PublicPageShell>
      <div className="help-layout">
        <aside className="help-navigation">
          <p className="section-kicker">帮助导航</p>
          <nav aria-label="帮助中心目录">
            {result.data.navigation.map((item) => {
              const href = item.slug.length === 0 ? '/help' : `/help/${item.slug.join('/')}`;
              return (
                <Link
                  aria-current={item.slug.join('/') === slug.join('/') ? 'page' : undefined}
                  href={href}
                  key={href}
                >
                  {item.title}
                </Link>
              );
            })}
          </nav>
        </aside>

        <article className="help-article">
          <header>
            <p className="section-kicker">
              {article.kind === 'LEGAL'
                ? '规则说明'
                : article.kind === 'FAQ'
                  ? '常见问题'
                  : article.kind === 'ANNOUNCEMENT'
                    ? '平台公告'
                    : '使用指南'}
            </p>
            <h1>{article.title}</h1>
            <p>{article.summary}</p>
            <time dateTime={article.publishedAt}>发布于 {article.publishedAt}</time>
          </header>
          <div
            className="published-content"
            // The HTML is published Gateway content passed through a strict server-side allowlist.
            dangerouslySetInnerHTML={{ __html: safePublishedHtml }}
          />
        </article>
      </div>
    </PublicPageShell>
  );
}
