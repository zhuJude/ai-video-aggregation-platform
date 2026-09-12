import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { PublicErrorState, PublicPageShell } from '../../../components/public-page-shell';
import {
  generationModeLabels,
  modelStateLabels,
  publicSiteGateway,
} from '../../../lib/public-gateway';

interface ModelDetailPageProps {
  params: Promise<{ id: string }>;
}

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: ModelDetailPageProps): Promise<Metadata> {
  const { id } = await params;
  const result = await publicSiteGateway.getModel(id);
  if (!result.ok || !result.data) return { title: '模型详情' };
  return {
    title: result.data.displayName,
    description: result.data.publishedDescription,
  };
}

export default async function ModelDetailPage({ params }: ModelDetailPageProps) {
  const { id } = await params;
  const result = await publicSiteGateway.getModel(id);

  if (!result.ok) {
    return (
      <PublicPageShell>
        <PublicErrorState />
      </PublicPageShell>
    );
  }
  if (!result.data) notFound();

  const model = result.data;

  return (
    <PublicPageShell>
      <article className="model-detail">
        <header className="model-detail-header">
          <div>
            <Link className="back-link" href="/models">
              返回模型广场
            </Link>
            <p className="section-kicker">{model.provider.displayName}</p>
            <h1>{model.displayName}</h1>
            <p>{model.publishedDescription}</p>
          </div>
          <aside className="model-state-panel" aria-label="模型状态与价格">
            <span data-tone={model.state === 'MAINTENANCE' ? 'warning' : 'healthy'}>
              {modelStateLabels[model.state]}
            </span>
            <p>{model.stateMessage}</p>
            <strong>
              常见 {model.pointRange.min}-{model.pointRange.max} {model.pointRange.unit}
            </strong>
            {model.state === 'ACTIVE' ? (
              <Link className="button-link button-primary" href={`/studio?model=${model.id}`}>
                使用此模型
              </Link>
            ) : (
              <p className="model-action-unavailable" role="status">
                当前不可操作，模型恢复后才可开始新任务。
              </p>
            )}
          </aside>
        </header>

        <section className="model-detail-section" aria-labelledby="capabilities-title">
          <h2 id="capabilities-title">能力与适用方式</h2>
          <p className="model-mode-list">
            {model.modes.map((mode) => generationModeLabels[mode]).join('、')}
          </p>
          {model.capabilities.length === 0 ? (
            <p role="status">暂无已发布的能力说明。</p>
          ) : (
            <ul className="capability-grid">
              {model.capabilities.map((capability) => (
                <li key={capability}>{capability}</li>
              ))}
            </ul>
          )}
        </section>

        <section className="model-detail-section" aria-labelledby="billing-title">
          <h2 id="billing-title">点数规则</h2>
          <div className="billing-rule-grid">
            {model.billingRules.map((rule) => (
              <article key={rule.title}>
                <h3>{rule.title}</h3>
                <p>{rule.description}</p>
              </article>
            ))}
          </div>
          <Link href="/pricing">查看完整点数与退回规则</Link>
        </section>
      </article>
    </PublicPageShell>
  );
}
