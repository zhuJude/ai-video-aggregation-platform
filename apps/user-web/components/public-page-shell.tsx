import Link from 'next/link';
import type { ReactNode } from 'react';

const navigation = [
  { href: '/models', label: '模型广场' },
  { href: '/pricing', label: '价格说明' },
  { href: '/help', label: '帮助中心' },
] as const;

export function PublicPageShell({ children }: { children: ReactNode }) {
  return (
    <div className="public-site">
      <Link className="skip-link" href="#public-main">
        跳到主要内容
      </Link>
      <header className="public-header">
        <div className="public-header-inner">
          <Link className="public-wordmark" href="/" aria-label="光帧首页">
            <span className="brand-mark" aria-hidden="true">
              光
            </span>
            <span>光帧 AI</span>
          </Link>
          <nav className="public-navigation" aria-label="公共导航">
            {navigation.map((item) => (
              <Link key={item.href} href={item.href}>
                {item.label}
              </Link>
            ))}
          </nav>
          <Link className="public-login" href="/login">
            登录
          </Link>
        </div>
      </header>
      <main id="public-main" className="public-main" tabIndex={-1}>
        {children}
      </main>
      <footer className="public-footer">
        <div>
          <Link className="public-wordmark" href="/">
            光帧 AI
          </Link>
          <p>把模型选择、任务计费和作品管理放在同一个创作流程。</p>
        </div>
        <nav aria-label="页脚导航">
          {navigation.map((item) => (
            <Link key={item.href} href={item.href}>
              {item.label}
            </Link>
          ))}
          <Link href="/help/legal/terms">服务条款</Link>
        </nav>
      </footer>
    </div>
  );
}

export function PublicErrorState() {
  return (
    <section className="public-state" role="alert">
      <p className="section-kicker">加载失败</p>
      <h1>公开信息暂时无法显示</h1>
      <p>请稍后重新打开本页。</p>
    </section>
  );
}
