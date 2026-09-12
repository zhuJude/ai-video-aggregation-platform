'use client';

import { useState } from 'react';

import { updateProfileAction } from '../../app/account-actions';
import {
  completeUploadAction,
  createUploadSessionAction,
  requestAssetAccessAction,
} from '../../app/commerce-actions';
import { runAccountActionWithRefresh } from '../../lib/account/client-command';
import { runCommerceActionWithRefresh } from '../../lib/commerce/client-command';
import { uploadAssetBytesWithSessionRefresh } from '../../lib/commerce/upload-client';
import { formatAccountDate } from '../../lib/account/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { AccountActionResult, ProfileView } from '../../lib/account/types';

type ProfileInput = Pick<ProfileView, 'nickname' | 'avatarPreset' | 'avatarAssetId'>;

export function ProfileSettings({
  initial,
  initialAvatarUrl,
  onSave,
  onUploadAvatar,
}: {
  readonly initial: ProfileView;
  readonly initialAvatarUrl?: string;
  readonly onSave?: (input: ProfileInput, key: string) => Promise<AccountActionResult<ProfileView>>;
  readonly onUploadAvatar?: (
    file: File,
    key: string,
  ) => Promise<AccountActionResult<{ readonly assetId: string; readonly previewUrl: string }>>;
}) {
  const [saved, setSaved] = useState(initial);
  const [nickname, setNickname] = useState(initial.nickname);
  const [avatarPreset, setAvatarPreset] = useState(initial.avatarPreset);
  const [avatarAssetId, setAvatarAssetId] = useState(initial.avatarAssetId);
  const [avatarUrl, setAvatarUrl] = useState(initialAvatarUrl);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
  const [nicknameError, setNicknameError] = useState<string>();
  const [avatarError, setAvatarError] = useState<string>();
  const uploadAvatar = async (file: File | undefined) => {
    if (!file || pending) return;
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
      file.size <= 0 ||
      file.size > 5 * 1024 * 1024
    ) {
      setAvatarError('头像仅支持 JPG、PNG、WebP，且不超过 5 MB。');
      return;
    }
    setPending(true);
    setError(undefined);
    setAvatarError(undefined);
    const key = createUuidV7();
    try {
      let uploaded: { readonly assetId: string; readonly previewUrl: string };
      if (onUploadAvatar) {
        const result = await onUploadAvatar(file, key);
        if (!result.ok) throw new Error(result.outcome);
        uploaded = result.data;
      } else {
        const grant = await runCommerceActionWithRefresh(() =>
          createUploadSessionAction({ name: file.name, size: file.size, type: file.type }, key),
        );
        if (!grant.ok) throw new Error(grant.outcome);
        const receipt = await uploadAssetBytesWithSessionRefresh(grant.data, file, {
          signal: new AbortController().signal,
          onProgress: () => undefined,
        });
        const completed = await runCommerceActionWithRefresh(() =>
          completeUploadAction(receipt, key),
        );
        if (!completed.ok) throw new Error(completed.outcome);
        const preview = await runCommerceActionWithRefresh(() =>
          requestAssetAccessAction(completed.data.id, 'PREVIEW'),
        );
        if (!preview.ok) throw new Error(preview.outcome);
        uploaded = { assetId: completed.data.id, previewUrl: preview.data.url };
      }
      setAvatarAssetId(uploaded.assetId);
      setAvatarUrl(uploaded.previewUrl);
      setFeedback('头像已上传，保存资料后生效。');
    } catch (caught) {
      setAvatarError(
        caught instanceof Error && caught.message === 'UNCERTAIN'
          ? '头像上传结果待确认，请到素材页核对。'
          : '头像上传失败，请检查图片后重试。',
      );
    } finally {
      setPending(false);
    }
  };
  const submit = async () => {
    const normalized = nickname.trim();
    if (
      !normalized ||
      normalized.length > 40 ||
      Array.from(normalized).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      })
    ) {
      setNicknameError('昵称须为 1–40 个可见字符。');
      return;
    }
    const previous = saved;
    setSaved({
      ...saved,
      nickname: normalized,
      avatarPreset,
      ...(avatarAssetId ? { avatarAssetId } : {}),
    });
    setPending(true);
    setError(undefined);
    setNicknameError(undefined);
    setFeedback('正在保存…');
    const key = createUuidV7();
    const input = {
      nickname: normalized,
      avatarPreset,
      ...(avatarAssetId ? { avatarAssetId } : {}),
    };
    const result = onSave
      ? await onSave(input, key)
      : await runAccountActionWithRefresh(key, (sameKey) => updateProfileAction(input, sameKey));
    setPending(false);
    if (result.ok) {
      setSaved(result.data);
      setFeedback('资料已更新。');
    } else {
      setSaved(previous);
      setFeedback(undefined);
      setError(
        result.outcome === 'UNCERTAIN'
          ? '保存结果待确认，请刷新页面核对。'
          : '资料未保存，请检查内容后重试。',
      );
    }
  };
  return (
    <section className="settings-panel" aria-labelledby="profile-title">
      <p className="section-kicker">个人资料</p>
      <h1 id="profile-title">资料设置</h1>
      <div className="profile-preview" data-avatar={saved.avatarPreset}>
        {avatarUrl ? (
          <img src={avatarUrl} alt={`${saved.nickname}的头像`} />
        ) : (
          <span aria-hidden="true">{saved.nickname.slice(0, 1)}</span>
        )}
        <div>
          <strong>{saved.nickname}</strong>
          <p>{saved.phoneMasked}</p>
        </div>
      </div>
      <div className="settings-form">
        <label htmlFor="nickname">昵称</label>
        <input
          id="nickname"
          value={nickname}
          maxLength={40}
          aria-invalid={nicknameError ? true : undefined}
          aria-describedby={nicknameError ? 'nickname-error' : 'nickname-help'}
          onChange={(event) => {
            setNickname(event.target.value);
            setNicknameError(undefined);
          }}
        />
        <small id="nickname-help">1–40 个字符。</small>
        {nicknameError ? (
          <small id="nickname-error" role="alert">
            {nicknameError}
          </small>
        ) : null}
        <label htmlFor="avatar-upload">上传头像图片</label>
        <input
          id="avatar-upload"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          disabled={pending}
          aria-invalid={avatarError ? true : undefined}
          aria-describedby={avatarError ? 'avatar-upload-error' : undefined}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            void uploadAvatar(file);
          }}
        />
        {avatarError ? (
          <small id="avatar-upload-error" role="alert">
            {avatarError}
          </small>
        ) : null}
        <label htmlFor="avatar-preset">头像配色</label>
        <select
          id="avatar-preset"
          value={avatarPreset}
          onChange={(event) => {
            setAvatarPreset(event.target.value as ProfileView['avatarPreset']);
          }}
        >
          <option value="AMBER">琥珀</option>
          <option value="BLUE">蓝色</option>
          <option value="GREEN">绿色</option>
          <option value="PLUM">梅紫</option>
        </select>
        <button type="button" disabled={pending} onClick={() => void submit()}>
          {pending ? '正在保存…' : '保存资料'}
        </button>
      </div>
      <p>
        上次更新：<time dateTime={saved.updatedAt}>{formatAccountDate(saved.updatedAt)}</time>
      </p>
      {feedback ? <p role="status">{feedback}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
