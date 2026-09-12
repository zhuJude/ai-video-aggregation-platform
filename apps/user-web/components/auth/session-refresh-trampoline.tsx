'use client';

import { useEffect, useState } from 'react';

import { coordinateSessionRefresh } from '../../lib/auth/client-session';

export function SessionRefreshTrampoline({ returnTo }: { readonly returnTo: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    void coordinateSessionRefresh()
      .then((refreshed) => {
        if (!active) return;
        if (refreshed) globalThis.location.replace(returnTo);
        else setFailed(true);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [returnTo]);
  return failed ? (
    <a href="/login">登录状态已失效，请重新登录</a>
  ) : (
    <p role="status">正在安全续期登录状态……</p>
  );
}
