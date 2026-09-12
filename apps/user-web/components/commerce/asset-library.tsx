'use client';

import { useEffect, useRef, useState } from 'react';

import {
  completeUploadAction,
  createUploadSessionAction,
  deleteAssetAction,
  renameAssetAction,
  requestAssetAccessAction,
} from '../../app/commerce-actions';
import {
  classifyCommerceCommandError,
  formatChinaDate,
  parseAssetPage,
  parseSignedAssetUrl,
  usableSignedUrl,
} from '../../lib/commerce/runtime';
import { runCommerceActionWithRefresh } from '../../lib/commerce/client-command';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import { uploadAssetBytesWithSessionRefresh } from '../../lib/commerce/upload-client';
import type {
  AssetListItem,
  AssetPage,
  CommerceGateway,
  SignedAssetUrl,
} from '../../lib/commerce/types';
import { AccessibleDialog } from './accessible-dialog';

const ALLOWED_UPLOADS = /^(?:image\/(?:jpeg|png|webp)|video\/mp4)$/;
const IMAGE_LIMIT = 20n * 1024n * 1024n;
const VIDEO_LIMIT = 500n * 1024n * 1024n;

type Feedback = { readonly tone: 'status' | 'alert'; readonly message: string } | undefined;

function formatBytes(value: string): string {
  const bytes = BigInt(value);
  if (bytes >= 1024n * 1024n) return `${(bytes / (1024n * 1024n)).toLocaleString('en-US')} MB`;
  if (bytes >= 1024n) return `${(bytes / 1024n).toLocaleString('en-US')} KB`;
  return `${bytes.toLocaleString('en-US')} B`;
}

function validateUpload(file: File): string | undefined {
  if (!ALLOWED_UPLOADS.test(file.type)) return '仅支持 JPG、PNG、WebP 图片或 MP4 视频。';
  const limit = file.type.startsWith('image/') ? IMAGE_LIMIT : VIDEO_LIMIT;
  if (BigInt(file.size) <= 0n || BigInt(file.size) > limit)
    return file.type.startsWith('image/') ? '图片不能超过 20 MB。' : '视频不能超过 500 MB。';
  return undefined;
}

interface AssetLibraryProps {
  readonly initial: AssetPage;
  readonly gateway?: CommerceGateway;
  readonly ownerId?: string;
}

export function AssetLibrary({ initial, gateway, ownerId }: AssetLibraryProps) {
  const [items, setItems] = useState(initial.items);
  const [access, setAccess] = useState<Record<string, SignedAssetUrl>>({});
  const [accessClock, setAccessClock] = useState(() => Date.now());
  const [progress, setProgress] = useState<number>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [deleting, setDeleting] = useState<AssetListItem>();
  const [renaming, setRenaming] = useState<AssetListItem>();
  const [renameValue, setRenameValue] = useState('');
  const [busy, setBusy] = useState(false);
  const uploadController = useRef<AbortController | undefined>(undefined);

  useEffect(() => {
    if (Object.keys(access).length === 0) return;
    const interval = window.setInterval(() => {
      setAccessClock(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [access]);

  const cancelUpload = () => {
    const controller = uploadController.current;
    if (!controller) return;
    controller.abort(new DOMException('User canceled upload', 'AbortError'));
    uploadController.current = undefined;
    setProgress(undefined);
    setFeedback({ tone: 'status', message: '上传已取消。' });
  };

  const accessAsset = async (asset: AssetListItem, purpose: 'PREVIEW' | 'DOWNLOAD') => {
    setFeedback(undefined);
    try {
      const raw = gateway
        ? await gateway.requestAssetAccess(asset.id, purpose, { ownerId: ownerId ?? '' })
        : await runCommerceActionWithRefresh(() =>
            requestAssetAccessAction(asset.id, purpose),
          ).then((result) => {
            if (!result.ok)
              throw Object.assign(new Error(result.outcome), { outcome: result.outcome });
            return result.data;
          });
      const grant = parseSignedAssetUrl(raw);
      const url = usableSignedUrl(grant);
      if (!url) throw new Error('SIGNED_URL_EXPIRED');
      setAccessClock(Date.now());
      setAccess((current) => ({ ...current, [`${asset.id}:${purpose}`]: grant }));
    } catch (error) {
      setFeedback({
        tone: 'alert',
        message:
          typeof error === 'object' &&
          error !== null &&
          'outcome' in error &&
          error.outcome === 'LOGIN_REQUIRED'
            ? '登录状态已失效，请重新登录后获取访问链接。'
            : '访问链接已过期或暂不可用，请重新获取。',
      });
    }
  };

  const upload = async (file: File) => {
    const validation = validateUpload(file);
    if (validation) {
      setFeedback({ tone: 'alert', message: validation });
      return;
    }
    const controller = new AbortController();
    uploadController.current = controller;
    setProgress(0);
    setFeedback({ tone: 'status', message: `正在上传 ${file.name}` });
    const key = createUuidV7();
    try {
      if (gateway || ownerId) throw new Error('INJECTED_UPLOAD_NOT_SUPPORTED');
      const grant = await runCommerceActionWithRefresh(() =>
        createUploadSessionAction({ name: file.name, size: file.size, type: file.type }, key),
      ).then((result) => {
        if (!result.ok) throw Object.assign(new Error(result.outcome), { outcome: result.outcome });
        return result.data;
      });
      const receipt = await uploadAssetBytesWithSessionRefresh(grant, file, {
        signal: controller.signal,
        onProgress: (percentage) => {
          setProgress(percentage);
        },
      });
      const raw = await runCommerceActionWithRefresh(() => completeUploadAction(receipt, key)).then(
        (result) => {
          if (!result.ok)
            throw Object.assign(new Error(result.outcome), { outcome: result.outcome });
          return result.data;
        },
      );
      if (controller.signal.aborted) return;
      const uploaded = parseAssetPage({ items: [raw], pageInfo: {} }).items[0];
      if (!uploaded) throw new Error('INVALID_UPLOAD_RESULT');
      setItems((current) => [uploaded, ...current]);
      setFeedback({ tone: 'status', message: '上传完成，可在生成工作台中复用。' });
    } catch (error) {
      if (!controller.signal.aborted) {
        setFeedback({
          tone: 'alert',
          message:
            typeof error === 'object' &&
            error !== null &&
            'outcome' in error &&
            error.outcome === 'LOGIN_REQUIRED'
              ? '登录状态已失效，请重新登录后上传。'
              : '上传未完成，请检查网络后重试。',
        });
      }
    } finally {
      if (uploadController.current === controller) {
        uploadController.current = undefined;
        setProgress(undefined);
      }
    }
  };

  const confirmDelete = async () => {
    if (!deleting || busy) return;
    setBusy(true);
    const key = createUuidV7();
    try {
      const raw = gateway
        ? await gateway.deleteAsset(deleting.id, {
            idempotencyKey: key,
            ownerId: ownerId ?? '',
          })
        : await runCommerceActionWithRefresh(() => deleteAssetAction(deleting.id, key)).then(
            (result) => {
              if (!result.ok)
                throw Object.assign(new Error(result.outcome), { outcome: result.outcome });
              return result.data;
            },
          );
      if (typeof raw !== 'object' || raw === null || !('accepted' in raw) || raw.accepted !== true)
        throw new Error('INVALID_DELETE_RESULT');
      setItems((current) => current.filter((item) => item.id !== deleting.id));
      setDeleting(undefined);
      setFeedback({ tone: 'status', message: '删除请求已受理，可在 7 天内联系支持恢复。' });
    } catch (error) {
      const uncertain = classifyCommerceCommandError(error) === 'UNCERTAIN';
      const loginRequired =
        typeof error === 'object' &&
        error !== null &&
        'outcome' in error &&
        error.outcome === 'LOGIN_REQUIRED';
      setDeleting(undefined);
      setFeedback({
        tone: 'alert',
        message: loginRequired
          ? '登录状态已失效，请重新登录后再删除。'
          : uncertain
            ? '删除结果暂无法确认，请刷新素材列表核对，避免重复操作。'
            : '无法删除这个素材。',
      });
    } finally {
      setBusy(false);
    }
  };

  const confirmRename = async () => {
    if (!renaming || busy) return;
    if (!renameValue.trim() || renameValue.length > 120) {
      setFeedback({ tone: 'alert', message: '名称应为 1–120 个字符。' });
      return;
    }
    setBusy(true);
    const key = createUuidV7();
    try {
      const raw = gateway
        ? await gateway.renameAsset(renaming.id, renameValue, {
            idempotencyKey: key,
            ownerId: ownerId ?? '',
          })
        : await runCommerceActionWithRefresh(() =>
            renameAssetAction(renaming.id, renameValue, key),
          ).then((result) => {
            if (!result.ok)
              throw Object.assign(new Error(result.outcome), { outcome: result.outcome });
            return result.data;
          });
      const renamed = parseAssetPage({ items: [raw], pageInfo: {} }).items[0];
      if (!renamed) throw new Error('INVALID_RENAME_RESULT');
      setItems((current) => current.map((item) => (item.id === renamed.id ? renamed : item)));
      setRenaming(undefined);
      setFeedback({ tone: 'status', message: '名称已更新。' });
    } catch (error) {
      setRenaming(undefined);
      const loginRequired =
        typeof error === 'object' &&
        error !== null &&
        'outcome' in error &&
        error.outcome === 'LOGIN_REQUIRED';
      setFeedback({
        tone: 'alert',
        message: loginRequired
          ? '登录状态已失效，请重新登录后再重命名。'
          : classifyCommerceCommandError(error) === 'UNCERTAIN'
            ? '重命名结果暂无法确认，请刷新后核对。'
            : '无法更新名称。',
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="asset-upload-panel" aria-labelledby="upload-title">
        <div>
          <p className="section-kicker">添加素材</p>
          <h2 id="upload-title">上传到私有素材库</h2>
          <p>图片最大 20 MB，MP4 视频最大 500 MB。文件会按账户隔离存储。</p>
        </div>
        <label className="upload-picker">
          <span>选择文件</span>
          <input
            aria-label="上传图片或视频"
            type="file"
            accept="image/jpeg,image/png,image/webp,video/mp4"
            disabled={progress !== undefined}
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void upload(file);
              event.currentTarget.value = '';
            }}
          />
        </label>
        {progress !== undefined ? (
          <div className="upload-progress">
            <progress max={100} value={progress} aria-label="上传进度" />
            <strong>{progress}%</strong>
            <button type="button" className="button-danger-subtle" onClick={cancelUpload}>
              取消上传
            </button>
          </div>
        ) : null}
      </section>

      {feedback ? (
        <p
          className={`commerce-feedback ${feedback.tone === 'alert' ? 'is-error' : ''}`}
          role={feedback.tone}
          aria-live="polite"
        >
          {feedback.message}
        </p>
      ) : null}

      {items.length === 0 ? (
        <div className="commerce-empty" role="status">
          <h2>暂无作品或素材</h2>
          <p>上传参考素材，或完成一次生成后，内容会安全地出现在这里。</p>
        </div>
      ) : (
        <div className="asset-grid">
          {items.map((asset) => {
            const previewGrant = access[`${asset.id}:PREVIEW`];
            const downloadGrant = access[`${asset.id}:DOWNLOAD`];
            const preview = previewGrant ? usableSignedUrl(previewGrant, accessClock) : undefined;
            const download = downloadGrant
              ? usableSignedUrl(downloadGrant, accessClock)
              : undefined;
            return (
              <article className="asset-card" key={asset.id}>
                <div className="asset-preview">
                  {preview ? (
                    asset.mimeType.startsWith('video/') ? (
                      <video
                        src={preview}
                        controls
                        preload="metadata"
                        aria-label={asset.posterAlt}
                      />
                    ) : (
                      <img src={preview} alt={asset.posterAlt} />
                    )
                  ) : (
                    <button
                      type="button"
                      className="preview-request"
                      onClick={() => void accessAsset(asset, 'PREVIEW')}
                    >
                      <span aria-hidden="true">▶</span>加载短时预览
                    </button>
                  )}
                </div>
                <div className="asset-card-body">
                  <div>
                    <span className="status-chip">
                      {asset.kind === 'RESULT' ? '生成作品' : '上传素材'}
                    </span>
                    <h3>{asset.name}</h3>
                  </div>
                  <dl>
                    <div>
                      <dt>大小</dt>
                      <dd>{formatBytes(asset.sizeBytes)}</dd>
                    </div>
                    <div>
                      <dt>加入时间</dt>
                      <dd>
                        <time dateTime={asset.createdAt}>{formatChinaDate(asset.createdAt)}</time>
                      </dd>
                    </div>
                  </dl>
                  <div className="asset-actions">
                    {download ? (
                      <a
                        className="button-link button-secondary"
                        href={download}
                        download={asset.name}
                        rel="noreferrer"
                      >
                        开始下载
                      </a>
                    ) : (
                      <button
                        type="button"
                        className="button-secondary-plain"
                        onClick={() => void accessAsset(asset, 'DOWNLOAD')}
                      >
                        获取下载链接
                      </button>
                    )}
                    <button
                      type="button"
                      className="button-secondary-plain"
                      onClick={() => {
                        setRenaming(asset);
                        setRenameValue(asset.name);
                      }}
                    >
                      重命名
                    </button>
                    <button
                      type="button"
                      className="button-danger-subtle"
                      aria-label={`删除${asset.name}`}
                      onClick={() => {
                        setDeleting(asset);
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {deleting ? (
        <AccessibleDialog
          labelledBy="delete-title"
          busy={busy}
          onClose={() => {
            setDeleting(undefined);
          }}
        >
          <p className="section-kicker">确认操作</p>
          <h2 id="delete-title">删除“{deleting.name}”？</h2>
          <p>素材会立即从列表隐藏，可在 7 天内恢复。正在运行的任务快照不会被修改。</p>
          <div className="dialog-actions">
            <button
              type="button"
              className="button-secondary-plain"
              onClick={() => {
                setDeleting(undefined);
              }}
              disabled={busy}
            >
              保留素材
            </button>
            <button
              type="button"
              className="button-danger"
              onClick={() => void confirmDelete()}
              disabled={busy}
            >
              {busy ? '正在提交…' : '确认删除'}
            </button>
          </div>
        </AccessibleDialog>
      ) : null}
      {renaming ? (
        <AccessibleDialog
          labelledBy="rename-title"
          busy={busy}
          onClose={() => {
            setRenaming(undefined);
          }}
        >
          <p className="section-kicker">素材信息</p>
          <h2 id="rename-title">重命名素材</h2>
          <label htmlFor="asset-name">新名称</label>
          <input
            id="asset-name"
            value={renameValue}
            maxLength={120}
            onChange={(event) => {
              setRenameValue(event.target.value);
            }}
          />
          <div className="dialog-actions">
            <button
              type="button"
              className="button-secondary-plain"
              onClick={() => {
                setRenaming(undefined);
              }}
              disabled={busy}
            >
              取消
            </button>
            <button type="button" onClick={() => void confirmRename()} disabled={busy}>
              {busy ? '正在保存…' : '保存名称'}
            </button>
          </div>
        </AccessibleDialog>
      ) : null}
    </>
  );
}
