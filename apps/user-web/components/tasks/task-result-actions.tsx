'use client';

import { useState } from 'react';

import { requestTaskResultAccessAction } from '../../app/tasks/actions';
import { retryOnceAfterSessionRefresh } from '../../lib/auth/client-session';

type ResultAccess =
  | { readonly ok: true; readonly url: string; readonly expiresAt: string }
  | { readonly ok: false; readonly outcome: 'SESSION_REFRESH_REQUIRED' | 'DEFINITIVE_FAILURE' };

interface TaskResultActionsProps {
  readonly taskId: string;
  readonly requestAccess?: (
    taskId: string,
    purpose: 'PREVIEW' | 'DOWNLOAD',
  ) => Promise<ResultAccess>;
}

async function serverAccess(
  taskId: string,
  purpose: 'PREVIEW' | 'DOWNLOAD',
): Promise<ResultAccess> {
  return retryOnceAfterSessionRefresh(
    () => requestTaskResultAccessAction(taskId, purpose),
    (result) => !result.ok && result.outcome === 'SESSION_REFRESH_REQUIRED',
  );
}

export function TaskResultActions({
  requestAccess = serverAccess,
  taskId,
}: TaskResultActionsProps) {
  const [loading, setLoading] = useState<'PREVIEW' | 'DOWNLOAD'>();
  const [access, setAccess] = useState<{
    readonly url: string;
    readonly purpose: 'PREVIEW' | 'DOWNLOAD';
  }>();
  const [error, setError] = useState<string>();

  const request = async (purpose: 'PREVIEW' | 'DOWNLOAD') => {
    if (loading) return;
    setLoading(purpose);
    setError(undefined);
    try {
      const result = await requestAccess(taskId, purpose);
      if (!result.ok) {
        setError('暂时无法签发结果访问链接，请稍后重试。');
        return;
      }
      setAccess({ purpose, url: result.url });
    } catch {
      setError('暂时无法签发结果访问链接，请稍后重试。');
    } finally {
      setLoading(undefined);
    }
  };

  return (
    <section className="task-panel task-result-panel" aria-labelledby="task-result-title">
      <div className="panel-heading">
        <h2 id="task-result-title">生成结果</h2>
        <span>短时授权</span>
      </div>
      <p>预览和下载链接按需签发，并会在五分钟内自动失效。</p>
      <div className="task-detail-actions">
        <button disabled={Boolean(loading)} type="button" onClick={() => void request('PREVIEW')}>
          {loading === 'PREVIEW' ? '正在签发预览' : '预览结果'}
        </button>
        <button disabled={Boolean(loading)} type="button" onClick={() => void request('DOWNLOAD')}>
          {loading === 'DOWNLOAD' ? '正在签发下载' : '下载结果'}
        </button>
      </div>
      {access ? (
        <a
          className="button-link button-primary"
          href={access.url}
          rel="noreferrer"
          target="_blank"
        >
          {access.purpose === 'PREVIEW' ? '打开短时预览' : '打开短时下载'}
        </a>
      ) : null}
      {error ? (
        <p className="form-feedback form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
