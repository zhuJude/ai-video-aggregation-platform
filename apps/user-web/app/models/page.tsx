import type { Metadata } from 'next';
import Link from 'next/link';

import { PublicErrorState, PublicPageShell } from '../../components/public-page-shell';
import {
  generationModeLabels,
  modelStateLabels,
  publicSiteGateway,
  type GenerationMode,
  type ModelFilters,
  type ModelState,
  type SpeedLabel,
} from '../../lib/public-gateway';

export const metadata: Metadata = {
  title: '模型广场',
  description: '按生成方式、提供商、能力、点数、速度和状态比较 AI 视频模型。',
};

type SearchParams = Record<string, string | string[] | undefined>;

const modes = Object.keys(generationModeLabels) as GenerationMode[];
const states = Object.keys(modelStateLabels) as ModelState[];
const speeds: SpeedLabel[] = ['较快', '均衡', '深度'];
const prices = ['UNDER_150', '150_TO_300', 'OVER_300'] as const;

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function allowedValue<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return allowed.includes(value as T) ? (value as T) : undefined;
}

function filtersFromSearchParams(searchParams: SearchParams): ModelFilters {
  const filters: ModelFilters = {};
  const modelId = firstValue(searchParams.model);
  const mode = allowedValue(firstValue(searchParams.mode), modes);
  const providerId = firstValue(searchParams.provider);
  const capability = firstValue(searchParams.capability);
  const price = allowedValue(firstValue(searchParams.price), prices);
  const speed = allowedValue(firstValue(searchParams.speed), speeds);
  const state = allowedValue(firstValue(searchParams.state), states);

  if (modelId) filters.modelId = modelId;
  if (mode) filters.mode = mode;
  if (providerId) filters.providerId = providerId;
  if (capability) filters.capability = capability;
  if (price) filters.price = price;
  if (speed) filters.speed = speed;
  if (state) filters.state = state;
  return filters;
}

export default async function ModelsPage({
  searchParams = Promise.resolve({}),
}: {
  searchParams?: Promise<SearchParams>;
}) {
  const filters = filtersFromSearchParams(await searchParams);
  const result = await publicSiteGateway.getModels(filters);

  return (
    <PublicPageShell>
      {!result.ok ? (
        <PublicErrorState />
      ) : (
        <>
          <section className="page-intro" aria-labelledby="models-title">
            <p className="section-kicker">模型广场</p>
            <h1 id="models-title">用任务条件筛选，不靠模型名称猜测</h1>
            <p>比较常见价格区间、能力倾向和服务状态。速度为定性参考，不代表保证耗时。</p>
          </section>

          <form className="model-filters" method="get" aria-label="筛选模型">
            <label>
              模型
              <select name="model" defaultValue={filters.modelId ?? ''}>
                <option value="">全部模型</option>
                {result.data.modelOptions.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              生成方式
              <select name="mode" defaultValue={filters.mode ?? ''}>
                <option value="">全部方式</option>
                {modes.map((mode) => (
                  <option key={mode} value={mode}>
                    {generationModeLabels[mode]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              提供商
              <select name="provider" defaultValue={filters.providerId ?? ''}>
                <option value="">全部提供商</option>
                {result.data.providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))}
              </select>
            </label>
            <label>
              能力
              <select name="capability" defaultValue={filters.capability ?? ''}>
                <option value="">全部能力</option>
                {result.data.capabilities.map((capability) => (
                  <option key={capability} value={capability}>
                    {capability}
                  </option>
                ))}
              </select>
            </label>
            <label>
              价格范围
              <select name="price" defaultValue={filters.price ?? ''}>
                <option value="">全部区间</option>
                <option value="UNDER_150">150 以下起</option>
                <option value="150_TO_300">150-300</option>
                <option value="OVER_300">300 以上</option>
              </select>
            </label>
            <label>
              速度倾向
              <select name="speed" defaultValue={filters.speed ?? ''}>
                <option value="">全部速度</option>
                {speeds.map((speed) => (
                  <option key={speed}>{speed}</option>
                ))}
              </select>
            </label>
            <label>
              服务状态
              <select name="state" defaultValue={filters.state ?? ''}>
                <option value="">全部状态</option>
                {states.map((state) => (
                  <option key={state} value={state}>
                    {state === 'ACTIVE' ? '仅看可用模型' : '仅看维护模型'}
                  </option>
                ))}
              </select>
            </label>
            <div className="filter-actions">
              <button type="submit">应用筛选</button>
              <Link href="/models">清除条件</Link>
            </div>
          </form>

          <section className="models-results" aria-labelledby="models-results-title">
            <div className="results-heading">
              <h2 id="models-results-title">可选模型</h2>
              <p aria-live="polite">{result.data.total} 个结果</p>
            </div>
            {result.data.items.length === 0 ? (
              <div className="public-state" role="status">
                <h3>没有匹配的模型</h3>
                <p>请放宽点数或能力条件后重试。</p>
              </div>
            ) : (
              <div className="models-grid">
                {result.data.items.map((model) => (
                  <article className="model-result-card" key={model.id}>
                    <div className="model-card-topline">
                      <span>{model.provider.displayName}</span>
                      <span data-tone={model.state === 'MAINTENANCE' ? 'warning' : 'healthy'}>
                        {modelStateLabels[model.state]}
                      </span>
                    </div>
                    <h3>{model.displayName}</h3>
                    <p className="model-mode-list">
                      {model.modes.map((mode) => `${generationModeLabels[mode]}能力`).join('、')}
                    </p>
                    <p>{model.publishedDescription}</p>
                    <dl className="model-facts">
                      <div>
                        <dt>常见价格</dt>
                        <dd>
                          {model.pointRange.min}-{model.pointRange.max} {model.pointRange.unit}
                        </dd>
                      </div>
                      <div>
                        <dt>速度</dt>
                        <dd>{model.speed}</dd>
                      </div>
                      <div>
                        <dt>质量倾向</dt>
                        <dd>{model.qualityLabel}</dd>
                      </div>
                    </dl>
                    <Link href={`/models/${model.id}`}>查看详情</Link>
                  </article>
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </PublicPageShell>
  );
}
