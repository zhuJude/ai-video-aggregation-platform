import type { Metadata } from 'next';

import { LoginPanel } from '../../components/login-panel';
import { preparePasswordAction, submitPasswordAction, submitTotpAction } from './actions';

export const metadata: Metadata = {
  title: '管理员登录',
};

export default function LoginPage() {
  return (
    <LoginPanel
      passwordAction={submitPasswordAction}
      preflightAction={preparePasswordAction}
      totpAction={submitTotpAction}
    />
  );
}
