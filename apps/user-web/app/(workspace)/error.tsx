'use client';

interface WorkspaceErrorProps {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function WorkspaceError({ reset }: WorkspaceErrorProps) {
  return (
    <section className="state-panel state-panel-error" role="alert">
      <h1>工作区暂时无法显示</h1>
      <p>请重试当前操作。若问题持续，请稍后再试。</p>
      <button type="button" onClick={reset}>
        重试
      </button>
    </section>
  );
}
