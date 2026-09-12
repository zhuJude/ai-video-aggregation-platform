import type { Metadata } from 'next';
import Link from 'next/link';

import { PublicErrorState, PublicPageShell } from '../../components/public-page-shell';
import { publicSiteGateway } from '../../lib/public-gateway';

export const metadata: Metadata = {
  title: '点数与计费',
  description: '了解光帧 AI 视频模型的点数换算、任务计费、失败退回与取消规则。',
};

export const dynamic = 'force-dynamic';

function formatMinorUnits(amountMinor: string): string {
  const minor = BigInt(amountMinor);
  const yuan = minor / 100n;
  const fraction = minor % 100n;
  return fraction === 0n
    ? yuan.toString()
    : `${yuan.toString()}.${fraction.toString().padStart(2, '0')}`;
}

function formatCny(amountMinor: string): string {
  return `¥${formatMinorUnits(amountMinor)}`;
}

function formatPoints(points: string): string {
  return BigInt(points).toLocaleString('zh-CN');
}

export default async function PricingPage() {
  const result = await publicSiteGateway.getPricing();

  return (
    <PublicPageShell>
      {!result.ok ? (
        <PublicErrorState />
      ) : (
        <>
          <section className="page-intro pricing-intro" aria-labelledby="pricing-title">
            <p className="section-kicker">点数与计费</p>
            <h1 id="pricing-title">每次提交前，先看清本次报价</h1>
            <p>
              不同模型、时长和输出规格对应不同点数。页面中的常见区间用于比较，实际以提交前报价为准。
            </p>
            <div className="conversion-callout">
              <span>点数换算</span>
              <strong>
                {formatMinorUnits(result.data.conversion.amountMinor)} 元 ={' '}
                {formatPoints(result.data.conversion.points)} 点数
              </strong>
            </div>
          </section>

          <section className="public-section pricing-rules" aria-labelledby="billing-rules-title">
            <div className="section-heading">
              <h2 id="billing-rules-title">任务如何计费</h2>
              <p>点数预留与最终结算分开，便于记录每次任务的资金状态。</p>
            </div>
            <div className="billing-rule-grid">
              {result.data.modelBillingRules.map((rule) => (
                <article key={rule.title}>
                  <h3>{rule.title}</h3>
                  <p>{rule.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="public-section policy-pair" aria-labelledby="refund-rules-title">
            <h2 id="refund-rules-title">失败与取消</h2>
            <article>
              <h3>失败任务</h3>
              <p>{result.data.failureRefundRule}</p>
            </article>
            <article>
              <h3>取消任务</h3>
              <p>{result.data.acceptedCancellationRule}</p>
            </article>
          </section>

          {result.data.rechargePackages ? (
            <section className="public-section recharge-section" aria-labelledby="recharge-title">
              <div className="section-heading">
                <h2 id="recharge-title">充值点数</h2>
                <p>各充值包使用相同换算规则，不含收益或价值承诺。</p>
              </div>
              <div className="recharge-grid">
                {result.data.rechargePackages.map((rechargePackage, index) => (
                  <article data-featured={index === 1} key={rechargePackage.id}>
                    <h3>{rechargePackage.title}</h3>
                    <strong>{formatCny(rechargePackage.amountMinor)}</strong>
                    <p>{formatPoints(rechargePackage.points)} 点数</p>
                    <Link href={`/wallet?package=${rechargePackage.id}`}>选择此充值包</Link>
                  </article>
                ))}
              </div>
              <p className="pricing-note">支付前请在钱包页确认金额、点数和有效的服务条款。</p>
            </section>
          ) : null}
        </>
      )}
    </PublicPageShell>
  );
}
