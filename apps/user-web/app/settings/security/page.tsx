import { redirect } from 'next/navigation';

import { AccountDeletion } from '../../../components/account/account-deletion';
import { PhoneChangeForm } from '../../../components/account/phone-change-form';
import { SessionList } from '../../../components/account/session-list';
import {
  readAuthenticatedServerSessionState,
  requireMutableAuthenticatedServerSessionIdentity,
} from '../../../lib/auth/server-session';
import { accountGateway } from '../../../lib/account/gateway';
import { parseSecuritySessions } from '../../../lib/account/runtime';

export default async function SecurityPage() {
  const state = await readAuthenticatedServerSessionState();
  if (state.kind === 'needs-refresh')
    redirect('/auth/session/refresh?returnTo=%2Fsettings%2Fsecurity');
  if (state.kind !== 'active') redirect('/login?returnTo=%2Fsettings%2Fsecurity');
  try {
    const identity = await requireMutableAuthenticatedServerSessionIdentity();
    const sessions = parseSecuritySessions(
      await accountGateway.listSessions({
        ownerId: identity.ownerId,
        currentSessionId: identity.sessionId,
        verifiedPhone: identity.verifiedPhone,
      }),
    );
    return (
      <div className="settings-page">
        <header className="commerce-heading">
          <div>
            <p className="section-kicker">账号保护</p>
            <h1>安全设置</h1>
            <p>设备标识已脱敏；页面不会展示访问令牌或内部会话编号。</p>
          </div>
        </header>
        <SessionList sessions={sessions} />
        <PhoneChangeForm />
        <AccountDeletion cooldownSeconds={0} />
      </div>
    );
  } catch {
    return (
      <section className="task-page-error" role="alert">
        <h1>暂时无法加载安全设置</h1>
        <p>安全服务不可用或响应未通过安全校验。</p>
        <a href="/settings/security">重新加载</a>
      </section>
    );
  }
}
