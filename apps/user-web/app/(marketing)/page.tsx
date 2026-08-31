import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';

import { PublicErrorState, PublicPageShell } from '../../components/public-page-shell';
import {
  generationModeLabels,
  modelStateLabels,
  publicSiteGateway,
} from '../../lib/public-gateway';

export const metadata: Metadata = {
  title: 'AI 视频创作平台',
  description: '比较主流 AI 视频模型，统一点数计费，管理从生成到交付的创作流程。',
};

export default async function HomePage() {
  const result = await publicSiteGateway.getHome();

  return (
    <PublicPageShell>
      {!result.ok ? (
        <PublicErrorState />
      ) : (
        <>
          <section className="marketing-hero" aria-labelledby="home-title">
            <div className="marketing-hero-copy">
              <h1 id="home-title">把好模型，变成稳定作品</h1>
              <p>聚合主流视频模型，用统一点数、任务记录和失败退回规则管理创作。</p>
              <div className="hero-actions">
                <Link className="button-link button-primary" href="/studio">
                  开始创作
                </Link>
                <Link className="button-link button-secondary" href="/models">
                  浏览模型
                </Link>
              </div>
            </div>
            <div className="marketing-hero-visual">
              <Image
                src="/ai-video-layered-coast-hero.png"
                width={1536}
                height={1024}
                sizes="(max-width: 767px) 100vw, 58vw"
                preload
                alt="多层视频画面中的海岸日落，展示 AI 视频创作过程"
              />
            </div>
          </section>

          <section className="public-section model-showcase" aria-labelledby="popular-models-title">
            <div className="section-heading">
              <h2 id="popular-models-title">先看能力，再选模型</h2>
              <p>每个模型都公开常见点数区间、质量倾向和当前状态。</p>
            </div>
            <div className="featured-models">
              {result.data.popularModels.map((model, index) => (
                <article className="featured-model" data-featured={index === 0} key={model.id}>
                  <div className="model-card-topline">
                    <span>{model.provider.displayName}</span>
                    <span data-tone={model.state === 'MAINTENANCE' ? 'warning' : 'healthy'}>
                      {modelStateLabels[model.state]}
                    </span>
                  </div>
                  <h3>{model.displayName}</h3>
                  <p>
                    {model.modes.map((mode) => generationModeLabels[mode]).join('、')}，
                    {model.qualityLabel}。
                  </p>
                  <div className="model-card-meta">
                    <span>
                      常见 {model.pointRange.min}-{model.pointRange.max} 点数
                    </span>
                    <span>速度倾向：{model.speed}</span>
                  </div>
                  <Link href={`/models/${model.id}`}>查看详情</Link>
                </article>
              ))}
            </div>
          </section>

          <section className="public-section creator-cases" aria-labelledby="creator-cases-title">
            <div className="section-heading">
              <h2 id="creator-cases-title">从一个明确用途出发</h2>
              <p>把模型放进真实制作环节，更容易判断它是否适合当前素材。</p>
            </div>
            <div className="case-list">
              {result.data.creatorCases.map((creatorCase) => (
                <article key={creatorCase.id}>
                  <p className="case-category">{creatorCase.category}</p>
                  <h3>{creatorCase.title}</h3>
                  <p>{creatorCase.summary}</p>
                  <Link href={`/models/${creatorCase.modelId}`}>查看适用模型</Link>
                </article>
              ))}
            </div>
          </section>

          <section className="public-section start-band" aria-labelledby="start-title">
            <div>
              <h2 id="start-title">带着素材开始，报价确认后再生成</h2>
              <p>工作台会保留参数、点数与任务状态，方便迭代和交付。</p>
            </div>
          </section>
        </>
      )}
    </PublicPageShell>
  );
}
