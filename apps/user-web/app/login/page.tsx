import type { Metadata } from 'next';
import Link from 'next/link';

import { PhoneLoginForm } from '../../components/auth/phone-login-form';
import { safeReturnTo } from '../../lib/auth/safe-return-to';

export const metadata: Metadata = {
  title: '手机号登录',
  description: '使用短信验证码安全登录光帧 AI 视频工作台。',
};

export default async function LoginPage({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly returnTo?: string | string[] }>;
}) {
  const requested = searchParams ? (await searchParams).returnTo : undefined;
  const returnTo = requested === undefined ? '/studio' : safeReturnTo(requested);
  return (
    <main className="login-page">
      <section className="login-panel" aria-labelledby="login-title">
        <Link className="login-brand" href="/" aria-label="返回光帧首页">
          <span className="brand-mark" aria-hidden="true">
            光
          </span>
          <span>光帧 AI</span>
        </Link>
        <div className="login-heading">
          <p className="login-eyebrow">创作者工作台</p>
          <h1 id="login-title">手机号登录</h1>
          <p>验证码仅用于本次登录，请勿转发给他人。</p>
        </div>
        <PhoneLoginForm returnTo={returnTo} />
        <p className="login-privacy">
          继续即表示你同意平台服务条款与隐私政策。登录凭证由服务器安全管理。
        </p>
      </section>
    </main>
  );
}
