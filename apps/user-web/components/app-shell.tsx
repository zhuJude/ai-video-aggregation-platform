import Link from 'next/link';
import type { ReactNode } from 'react';

export interface AppShellUser {
  nickname: string;
  points: string;
  frozenPoints?: string;
}

interface AppShellProps {
  children: ReactNode;
  user?: AppShellUser | null;
}

const destinations = [
  { href: '/studio', label: '开始生成' },
  { href: '/tasks', label: '任务中心' },
  { href: '/assets', label: '作品素材' },
  { href: '/wallet', label: '点数钱包' },
] as const;

function formatPoints(points: string): string {
  try {
    return BigInt(points).toLocaleString('zh-CN');
  } catch {
    return points;
  }
}

export function LoadingState({ label = '正在加载' }: { label?: string }) {
  return (
    <section className="state-panel" role="status" aria-live="polite">
      <span className="state-marker" aria-hidden="true" />
      <p>{label}</p>
    </section>
  );
}

export function EmptyState({
  title = '暂无内容',
  description = '这里还没有可显示的内容。',
}: {
  title?: string;
  description?: string;
}) {
  return (
    <section className="state-panel" role="status" aria-label={title}>
      <h1>{title}</h1>
      <p>{description}</p>
    </section>
  );
}

export function AppShell({ children, user = null }: AppShellProps) {
  return (
    <>
      <Link className="skip-link" href="#main-content">
        跳到主要内容
      </Link>
      <div className="app-shell">
        <aside className="app-sidebar" aria-label="工作区侧边栏">
          <div className="app-sidebar-header">
            <Link className="brand" href="/" aria-label="光帧首页">
              <span className="brand-mark" aria-hidden="true">
                光
              </span>
              <span>
                <strong>光帧</strong>
                <small>AI 视频工作台</small>
              </span>
            </Link>

            {user ? (
              <section className="account-summary" aria-label={`${user.nickname}的点数`}>
                <p className="account-name">{user.nickname}</p>
                <dl className="points-summary">
                  <div>
                    <dt>可用点数</dt>
                    <dd>{formatPoints(user.points)}</dd>
                  </div>
                  <div>
                    <dt>冻结点数</dt>
                    <dd>{formatPoints(user.frozenPoints ?? '0')}</dd>
                  </div>
                </dl>
              </section>
            ) : (
              <Link className="sign-in-link" href="/login">
                登录后查看点数
              </Link>
            )}
          </div>

          <nav className="primary-navigation" aria-label="主要导航">
            <ul>
              {destinations.map((destination) => (
                <li key={destination.href}>
                  <Link href={destination.href}>{destination.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <main id="main-content" className="app-content" tabIndex={-1}>
          {children ?? <EmptyState />}
        </main>
      </div>
    </>
  );
}
