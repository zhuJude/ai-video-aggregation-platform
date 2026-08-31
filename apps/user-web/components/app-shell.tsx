'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface AppShellUser {
  nickname: string;
  points: string;
  frozenPoints?: string;
}

interface AppShellProps {
  children: ReactNode;
  user?: AppShellUser | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
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

export class AppErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  public override state: ErrorBoundaryState = { hasError: false };

  public static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  public override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('AppShell content render failed', error, info.componentStack);
  }

  public override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <section className="state-panel state-panel-error" role="alert">
          <h1>页面暂时无法显示</h1>
          <p>请重新加载页面。若问题持续，请稍后再试。</p>
          <button
            type="button"
            onClick={() => {
              window.location.reload();
            }}
          >
            重新加载
          </button>
        </section>
      );
    }

    return this.props.children;
  }
}

export function AppShell({ children, user = null }: AppShellProps) {
  return (
    <>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <div className="app-shell">
        <aside className="app-sidebar" aria-label="工作区侧边栏">
          <div className="app-sidebar-header">
            <a className="brand" href="/" aria-label="光帧首页">
              <span className="brand-mark" aria-hidden="true">
                光
              </span>
              <span>
                <strong>光帧</strong>
                <small>AI 视频工作台</small>
              </span>
            </a>

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
              <a className="sign-in-link" href="/login">
                登录后查看点数
              </a>
            )}
          </div>

          <nav className="primary-navigation" aria-label="主要导航">
            <ul>
              {destinations.map((destination) => (
                <li key={destination.href}>
                  <a href={destination.href}>{destination.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        <main id="main-content" className="app-content" tabIndex={-1}>
          <AppErrorBoundary>{children ?? <EmptyState />}</AppErrorBoundary>
        </main>
      </div>
    </>
  );
}
