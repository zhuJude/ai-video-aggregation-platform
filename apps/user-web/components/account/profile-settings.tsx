'use client';

import { useState } from 'react';

import { updateProfileAction } from '../../app/account-actions';
import { runAccountActionWithRefresh } from '../../lib/account/client-command';
import { formatAccountDate } from '../../lib/account/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { ProfileView } from '../../lib/account/types';

export function ProfileSettings({ initial }: { readonly initial: ProfileView }) {
  const [saved, setSaved] = useState(initial);
  const [nickname, setNickname] = useState(initial.nickname);
  const [avatarPreset, setAvatarPreset] = useState(initial.avatarPreset);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [error, setError] = useState<string>();
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
      setError('昵称须为 1–40 个可见字符。');
      return;
    }
    const previous = saved;
    setSaved({ ...saved, nickname: normalized, avatarPreset });
    setPending(true);
    setError(undefined);
    setFeedback('正在保存…');
    const key = createUuidV7();
    const result = await runAccountActionWithRefresh(key, (sameKey) =>
      updateProfileAction({ nickname: normalized, avatarPreset }, sameKey),
    );
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
        <span aria-hidden="true">{saved.nickname.slice(0, 1)}</span>
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
          aria-describedby="nickname-help"
          onChange={(event) => {
            setNickname(event.target.value);
          }}
        />
        <small id="nickname-help">1–40 个字符。</small>
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
