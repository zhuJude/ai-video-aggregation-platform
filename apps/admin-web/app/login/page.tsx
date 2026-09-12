import type { Metadata } from 'next';

import { LoginPanel } from '../../components/login-panel';
import { normalizeAdminLoginReturnTarget } from '../../lib/admin-return-target';
import { preparePasswordAction, submitPasswordAction, submitTotpAction } from './actions';

export const metadata: Metadata = {
  title: '管理员登录',
};

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ next?: string | string[] }> }>) {
  const params = await searchParams;
  const redirectTo = normalizeAdminLoginReturnTarget(params.next) ?? '/overview';
  return (
    <LoginPanel
      passwordAction={submitPasswordAction.bind(null, redirectTo)}
      preflightAction={preparePasswordAction}
      totpAction={submitTotpAction}
    />
  );
}
