'use client';

import type { SmartPreferences, StudioGenerationMode } from '../../lib/studio/types';

interface SmartModeProps {
  readonly value: SmartPreferences | undefined;
  readonly onChange: (value: SmartPreferences) => void;
}

const DEFAULT_PREFERENCES: SmartPreferences = {
  generationMode: 'IMAGE_TO_VIDEO',
  quality: 'BALANCED',
  speed: 'BALANCED',
  budgetPoints: 300,
  goal: '',
};

const generationModes: readonly { value: StudioGenerationMode; label: string }[] = [
  { value: 'TEXT_TO_VIDEO', label: '文生视频' },
  { value: 'IMAGE_TO_VIDEO', label: '图生视频' },
  { value: 'FIRST_LAST_FRAME', label: '首尾帧' },
  { value: 'REFERENCE_VIDEO', label: '参考视频' },
  { value: 'EXTEND_VIDEO', label: '视频延长' },
];

export function SmartMode({ onChange, value }: SmartModeProps) {
  const preferences = value ?? DEFAULT_PREFERENCES;
  const update = <Key extends keyof SmartPreferences>(
    key: Key,
    nextValue: SmartPreferences[Key],
  ) => {
    onChange({ ...preferences, [key]: nextValue });
  };

  return (
    <section className="mode-panel" aria-labelledby="smart-mode-title">
      <div className="mode-heading">
        <div>
          <h2 id="smart-mode-title">智能模式</h2>
          <p>报价时由智能路由选择满足条件的模型，并在任务快照中记录最终选择。</p>
        </div>
        <span className="mode-promise">不预先伪造最终模型</span>
      </div>

      <div className="preference-grid">
        <label>
          生成方式
          <select
            aria-label="生成方式"
            value={preferences.generationMode}
            onChange={(event) => {
              update('generationMode', event.target.value as StudioGenerationMode);
            }}
          >
            {generationModes.map((mode) => (
              <option key={mode.value} value={mode.value}>
                {mode.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          质量偏好
          <select
            aria-label="质量偏好"
            value={preferences.quality}
            onChange={(event) => {
              update('quality', event.target.value as SmartPreferences['quality']);
            }}
          >
            <option value="BALANCED">均衡</option>
            <option value="QUALITY_FIRST">质量优先</option>
          </select>
        </label>
        <label>
          速度偏好
          <select
            aria-label="速度偏好"
            value={preferences.speed}
            onChange={(event) => {
              update('speed', event.target.value as SmartPreferences['speed']);
            }}
          >
            <option value="BALANCED">均衡</option>
            <option value="SPEED_FIRST">速度优先</option>
          </select>
        </label>
        <label>
          预算上限
          <span className="input-with-unit">
            <input
              aria-label="预算上限"
              min={1}
              step={1}
              type="number"
              value={preferences.budgetPoints}
              onChange={(event) => {
                update('budgetPoints', Math.max(1, event.target.valueAsNumber || 1));
              }}
            />
            <span>点</span>
          </span>
        </label>
        <label className="preference-goal">
          创作目标
          <textarea
            aria-label="创作目标"
            maxLength={300}
            placeholder="例如：为新品制作节奏舒缓的横屏展示视频"
            rows={3}
            value={preferences.goal}
            onChange={(event) => {
              update('goal', event.target.value);
            }}
          />
        </label>
      </div>
    </section>
  );
}
