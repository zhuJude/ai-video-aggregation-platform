import { redirect } from 'next/navigation';

import { ProfileSettings } from '../../../components/account/profile-settings';
import {
  readAuthenticatedServerSessionState,
  requireMutableAuthenticatedServerSessionIdentity,
} from '../../../lib/auth/server-session';
import { accountGateway } from '../../../lib/account/gateway';
import { parseProfile } from '../../../lib/account/runtime';

export default async function ProfilePage() {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'needs-refresh')
    redirect('/auth/session/refresh?returnTo=%2Fsettings%2Fprofile');
  if (state.kind !== 'active') redirect('/login?returnTo=%2Fsettings%2Fprofile');
  try {
    const identity = await requireMutableAuthenticatedServerSessionIdentity();
    const profile = parseProfile(
      await accountGateway.getProfile({
        ownerId: identity.ownerId,
        currentSessionId: identity.sessionId,
        verifiedPhone: identity.verifiedPhone,
      }),
    );
    return (
      <div className="settings-page">
        <ProfileSettings initial={profile} />
      </div>
    );
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <h1>暂时无法加载个人资料</h1>
        <p>资料服务不可用或响应未通过安全校验。</p>
        <a href="/settings/profile">重新加载</a>
      </section>
    );
  }
}
