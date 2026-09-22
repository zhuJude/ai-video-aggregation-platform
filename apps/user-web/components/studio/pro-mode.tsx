'use client';

import type { ProSelection, StudioModelOption, StudioProviderOption } from '../../lib/studio/types';

interface ProModeProps {
  readonly providers: readonly StudioProviderOption[];
  readonly models: readonly StudioModelOption[];
  readonly value: ProSelection;
  readonly onChange: (value: ProSelection) => void;
}

function modelStatusLabel(status: StudioModelOption['status']): string {
  if (status === 'MAINTENANCE') return '维护中';
  if (status === 'DISABLED') return '已下架';
  return '可用';
}

export function ProMode({ models, onChange, providers, value }: ProModeProps) {
  const providerModels = models.filter((model) => model.providerId === value.providerId);
  const updateProvider = (providerId: string) => {
    const firstAvailable = models.find(
      (model) => model.providerId === providerId && model.status === 'ACTIVE',
    );
    onChange({ ...value, providerId, modelId: firstAvailable?.id ?? '' });
  };

  return (
    <section className="mode-panel" aria-labelledby="pro-mode-title">
      <div className="mode-heading">
        <div>
          <h2 id="pro-mode-title">专业模式</h2>
          <p>严格使用所选平台和模型；维护或下架模型不可提交，也不会被静默替换。</p>
        </div>
      </div>

      <div className="pro-selection-grid">
        <label>
          平台
          <select
            value={value.providerId}
            onChange={(event) => {
              updateProvider(event.target.value);
            }}
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          模型
          <select
            value={value.modelId}
            onChange={(event) => {
              onChange({ ...value, modelId: event.target.value });
            }}
          >
            {providerModels.map((model) => (
              <option key={model.id} disabled={model.status !== 'ACTIVE'} value={model.id}>
                {model.name} · {modelStatusLabel(model.status)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="fallback-consent">
        <input
          aria-label="允许同等能力故障切换"
          checked={value.allowEquivalentFallback}
          type="checkbox"
          onChange={(event) => {
            onChange({ ...value, allowEquivalentFallback: event.target.checked });
          }}
        />
        <span>
          <strong>允许同等能力故障切换</strong>
          <small>仅在原供应商明确未受理或未计费，且备用售价不超过本次报价时生效。</small>
        </span>
      </label>
    </section>
  );
}
