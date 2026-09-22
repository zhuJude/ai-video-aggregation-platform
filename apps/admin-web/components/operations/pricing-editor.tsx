'use client';

import {
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  Select,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useState } from 'react';

import {
  calculateMarginBps,
  formatBps,
  formatPoints,
  isPoints,
} from '../../lib/operations-control';
import { createUuidV7 } from '../../lib/uuid-v7';

type PricingPreview = Readonly<{
  expiresAt: string;
  previewToken: string;
  version: number;
  versionId: string;
}>;
type PricingEditorProps = Readonly<{
  costPoints: string;
  minimumMarginBps: number;
  onPreview: (form: FormData) => unknown;
  onPublish?: (form: FormData) => Promise<void>;
  onSave?: (form: FormData) => Promise<void>;
  permissions: readonly string[];
  salePoints: string;
  effectiveAt?: string;
  rules?: readonly Readonly<{
    costPoints: string;
    durationSeconds: number;
    id: string;
    markupBps: number;
    modelCode: string;
    parameterKey: string;
    resolution: string;
    salePoints: string;
    strategy: 'FIXED' | 'MARKUP' | 'TIERED';
    tiersJson: string;
  }>[];
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  version: number;
  versionId: string;
}>;

const useStyles = makeStyles({
  grid: {
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  },
  actions: { display: 'flex', gap: '8px', marginTop: '16px' },
  summary: {
    padding: '12px',
    backgroundColor: tokens.colorNeutralBackground2,
    borderRadius: tokens.borderRadiusMedium,
  },
});
const permitted = (permissions: readonly string[], permission: string) =>
  permissions.includes('*') || permissions.includes(permission);
function isPricingPreview(value: unknown): value is PricingPreview {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'expiresAt' in value &&
    'previewToken' in value &&
    'version' in value &&
    'versionId' in value,
  );
}

export function PricingEditor(props: PricingEditorProps) {
  const styles = useStyles();
  const [salePoints, setSalePoints] = useState(props.salePoints);
  const [ruleId, setRuleId] = useState(props.rules?.[0]?.id ?? 'current');
  const activeRule = props.rules?.find((rule) => rule.id === ruleId);
  const [strategy, setStrategy] = useState<'FIXED' | 'MARKUP' | 'TIERED'>(
    activeRule?.strategy ?? 'FIXED',
  );
  const [markupBps, setMarkupBps] = useState(String(activeRule?.markupBps ?? 0));
  const [tiersJson, setTiersJson] = useState(activeRule?.tiersJson ?? '[]');
  const costPoints = activeRule?.costPoints ?? props.costPoints;
  const [effectiveAt, setEffectiveAt] = useState(
    () => props.effectiveAt ?? new Date(Date.now() + 3_600_000).toISOString(),
  );
  const [draftReason, setDraftReason] = useState('');
  const [preview, setPreview] = useState<PricingPreview>();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishReason, setPublishReason] = useState('');
  const [publishConfirmed, setPublishConfirmed] = useState(false);
  const [publishIntentId, setPublishIntentId] = useState(() => createUuidV7());
  const marginBps = calculateMarginBps(costPoints, salePoints);
  const belowMinimum = marginBps === null || marginBps < props.minimumMarginBps;
  const editable = props.status === 'DRAFT' && permitted(props.permissions, 'pricing:write');
  const canPreview =
    props.status === 'DRAFT' &&
    (permitted(props.permissions, 'pricing:write') ||
      permitted(props.permissions, 'pricing:publish'));
  const activePreview =
    preview?.versionId === props.versionId &&
    preview.version === props.version &&
    Date.parse(preview.expiresAt) > Date.now()
      ? preview
      : undefined;

  async function requestPreview() {
    if (belowMinimum || pending) return;
    const form = new FormData();
    form.set('versionId', props.versionId);
    form.set('expectedVersion', String(props.version));
    form.set('ruleId', ruleId);
    form.set('strategy', strategy);
    form.set('markupBps', markupBps);
    form.set('tiersJson', tiersJson);
    form.set('salePoints', salePoints);
    form.set('effectiveAt', effectiveAt);
    setPending(true);
    setMessage('');
    try {
      const result = await props.onPreview(form);
      if (isPricingPreview(result)) {
        setPreview(result);
        setPublishIntentId(createUuidV7());
      }
      setMessage(isPricingPreview(result) ? '权威预检已完成' : '已提交权威影响预览');
    } catch {
      setPreview(undefined);
      setMessage('权威预检失败');
    } finally {
      setPending(false);
    }
  }

  async function publish() {
    if (!activePreview || !props.onPublish || pending) return;
    const form = new FormData();
    form.set('versionId', props.versionId);
    form.set('expectedVersion', String(props.version));
    if (!publishConfirmed || !publishReason.trim()) return;
    form.set('previewToken', activePreview.previewToken);
    form.set('intentId', publishIntentId);
    form.set('reason', publishReason.trim());
    form.set('confirmed', 'true');
    setPending(true);
    try {
      await props.onPublish(form);
      setMessage('定价发布请求已受理，可在审计记录中追踪');
      setPublishOpen(false);
    } catch {
      setMessage('发布被拒绝，版本或成本快照可能已变化');
    } finally {
      setPending(false);
    }
  }
  async function save() {
    if (!props.onSave || !editable || !draftReason.trim() || pending) return;
    const form = new FormData();
    form.set('versionId', props.versionId);
    form.set('expectedVersion', String(props.version));
    form.set('ruleId', ruleId);
    form.set('strategy', strategy);
    form.set('markupBps', markupBps);
    form.set('tiersJson', tiersJson);
    form.set('salePoints', salePoints);
    form.set('effectiveAt', effectiveAt);
    form.set('reason', draftReason.trim());
    form.set('intentId', createUuidV7());
    setPending(true);
    try {
      await props.onSave(form);
      setMessage('定价草稿已保存并写入审计记录');
      setPreview(undefined);
    } catch {
      setMessage('草稿保存被拒绝，版本可能已变化');
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label="定价版本编辑器">
      <div className={styles.grid}>
        {props.rules ? (
          <Field label="定价维度">
            <Select
              aria-label="定价维度"
              onChange={(_event, data) => {
                const next = props.rules?.find((rule) => rule.id === data.value);
                setRuleId(data.value);
                if (next) {
                  setSalePoints(next.salePoints);
                  setStrategy(next.strategy);
                  setMarkupBps(String(next.markupBps));
                  setTiersJson(next.tiersJson);
                }
                setPreview(undefined);
              }}
              value={ruleId}
            >
              {props.rules.map((rule) => (
                <option key={rule.id} value={rule.id}>
                  {rule.modelCode} · {String(rule.durationSeconds)}s · {rule.resolution} ·{' '}
                  {rule.parameterKey}
                </option>
              ))}
            </Select>
          </Field>
        ) : null}
        <Field label="供应商成本点数">
          <Input readOnly value={costPoints} />
        </Field>
        <Field label="销售点数">
          <Input
            aria-label="销售点数"
            disabled={!editable}
            inputMode="numeric"
            onChange={(_e, data) => {
              setSalePoints(data.value);
              setPreview(undefined);
            }}
            value={salePoints}
          />
        </Field>
        <Field label="生效时间（UTC）">
          <Input
            disabled={!editable}
            onChange={(_e, data) => {
              setEffectiveAt(data.value);
              setPreview(undefined);
            }}
            placeholder="2026-09-10T12:00:00Z"
            value={effectiveAt}
          />
        </Field>
        <Field label="定价策略">
          <Select
            disabled={!editable}
            onChange={(_event, data) => {
              if (data.value === 'FIXED' || data.value === 'MARKUP' || data.value === 'TIERED') {
                setStrategy(data.value);
                setPreview(undefined);
              }
            }}
            value={strategy}
          >
            <option value="FIXED">固定点数</option>
            <option value="MARKUP">成本加成</option>
            <option value="TIERED">阶梯定价</option>
          </Select>
        </Field>
        {strategy === 'MARKUP' ? (
          <Field label="加成 BPS">
            <Input
              disabled={!editable}
              inputMode="numeric"
              onChange={(_event, data) => {
                setMarkupBps(data.value);
                setPreview(undefined);
              }}
              value={markupBps}
            />
          </Field>
        ) : null}
        {strategy === 'TIERED' ? (
          <Field label="阶梯规则 JSON">
            <Textarea
              disabled={!editable}
              onChange={(_event, data) => {
                setTiersJson(data.value);
                setPreview(undefined);
              }}
              value={tiersJson}
            />
          </Field>
        ) : null}
        <Field label="变更原因">
          <Input
            disabled={!editable}
            onChange={(_e, data) => {
              setDraftReason(data.value);
            }}
            value={draftReason}
          />
        </Field>
      </div>
      <div className={styles.summary}>
        <Text>
          成本 {formatPoints(costPoints)} 点 · 售价 {formatPoints(salePoints)} 点 · 毛利{' '}
          {marginBps === null ? '—' : formatBps(marginBps)}
        </Text>
        <br />
        <Text>
          最低毛利阈值 {formatBps(props.minimumMarginBps)} · 版本 v{String(props.version)} (
          {props.status})
        </Text>
      </div>
      {!isPoints(salePoints) ? (
        <Text role="alert">销售点数必须是规范十进制整数字符串</Text>
      ) : belowMinimum ? (
        <Text role="alert">当前售价低于最低毛利率，禁止预检和发布</Text>
      ) : null}
      {message ? <Text role="status">{message}</Text> : null}
      <div className={styles.actions}>
        <Button
          disabled={!editable || !props.onSave || !draftReason.trim() || pending}
          onClick={() => {
            void save();
          }}
        >
          保存草稿
        </Button>
        <Button
          disabled={!canPreview || belowMinimum || pending}
          onClick={() => {
            void requestPreview();
          }}
        >
          权威影响预览
        </Button>
        <Button
          appearance="primary"
          disabled={!permitted(props.permissions, 'pricing:publish') || !activePreview || pending}
          onClick={() => {
            setPublishOpen(true);
          }}
        >
          发布定价
        </Button>
      </div>
      <Dialog
        open={publishOpen}
        onOpenChange={(_event, data) => {
          if (!data.open && !pending) setPublishOpen(false);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>发布定价版本</DialogTitle>
            <DialogContent>
              <Text>
                将按权威预检绑定的成本快照、生效时间和版本发布；发布端会再次检查最低毛利与并发版本。
              </Text>
              <Field label="发布原因">
                <Input
                  aria-label="发布原因"
                  maxLength={200}
                  onChange={(_event, data) => {
                    setPublishReason(data.value);
                  }}
                  value={publishReason}
                />
              </Field>
              <Checkbox
                checked={publishConfirmed}
                label="我确认发布此定价版本"
                onChange={(_event, data) => {
                  setPublishConfirmed(data.checked === true);
                }}
              />
            </DialogContent>
            <DialogActions>
              <Button
                disabled={pending}
                onClick={() => {
                  setPublishOpen(false);
                }}
              >
                返回
              </Button>
              <Button
                appearance="primary"
                disabled={pending || !publishConfirmed || !publishReason.trim()}
                onClick={() => {
                  void publish();
                }}
              >
                确认发布
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
