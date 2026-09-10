'use client';

import {
  Badge,
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
  Tab,
  TabList,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useRef, useState } from 'react';
import {
  formatPoints,
  redactRawPayload,
  type TaskDetail,
  type TaskOperation,
} from '../../lib/operations-control';
import { createUuidV7 } from '../../lib/uuid-v7';

const operationMetadata: Readonly<
  Record<TaskOperation, Readonly<{ label: string; permission: string }>>
> = {
  RETRY_PROVIDER: { label: '重试供应商', permission: 'tasks:retry' },
  SWITCH_PROVIDER: { label: '切换供应商', permission: 'tasks:switch' },
  CANCEL: { label: '取消任务', permission: 'tasks:cancel' },
  REFUND: { label: '人工退款', permission: 'tasks:refund' },
  REPAIR: { label: '修复状态', permission: 'tasks:repair' },
};
const useStyles = makeStyles({
  cards: {
    display: 'grid',
    gap: '12px',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
  },
  card: {
    padding: '12px',
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '12px' },
  raw: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: '480px', overflowY: 'auto' },
});
const permitted = (permissions: readonly string[], permission: string) =>
  permissions.includes('*') || permissions.includes(permission);

type TaskActionsProps = Readonly<{
  createIntentId?: () => string;
  onAction?: (form: FormData) => Promise<void>;
  permissions: readonly string[];
  task: TaskDetail;
}>;
export function TaskActions({
  createIntentId = createUuidV7,
  onAction = () => Promise.resolve(),
  permissions,
  task,
}: TaskActionsProps) {
  const styles = useStyles();
  const [selected, setSelected] = useState<TaskOperation>();
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const intent = useRef(createIntentId());
  const visible = task.allowedOperations.filter((operation) =>
    permitted(permissions, operationMetadata[operation].permission),
  );
  const purchaseIsUnsafe = (operation: TaskOperation) => {
    if (operation !== 'RETRY_PROVIDER' && operation !== 'SWITCH_PROVIDER') return false;
    const safety = task.operationPreviews.find((preview) => preview.operation === operation)?.purchaseSafety;
    return task.duplicatePurchaseRisk || (safety !== 'NOT_ACCEPTED' && safety !== 'CONFIRMED_NO_CHARGE');
  };
  const selectedPreview = task.operationPreviews.find((preview) => preview.operation === selected);
  async function submit() {
    if (!selected || !selectedPreview || !confirmed || !reason.trim() || pending) return;
    const form = new FormData();
    form.set('action', selected);
    form.set('taskId', task.id);
    form.set('expectedVersion', String(task.version));
    form.set('impactToken', selectedPreview.preflightToken);
    form.set('intentId', intent.current);
    form.set('reason', reason.trim());
    form.set('confirmed', 'true');
    setPending(true);
    try {
      await onAction(form);
      setMessage('操作请求已受理，可在审计记录中追踪');
      setSelected(undefined);
      intent.current = createIntentId();
    } catch {
      setMessage('操作被拒绝：任务状态或允许操作已变化');
    } finally {
      setPending(false);
    }
  }
  return (
    <section aria-label="任务高风险操作">
      {task.duplicatePurchaseRisk || task.attempt.acceptance === 'AMBIGUOUS' ? (
        <Text role="alert">供应商受理状态不明确，存在重复采购风险；重试和切换已禁止。</Text>
      ) : null}
      <div className={styles.actions}>
        {visible.map((operation) => (
          <Button
            disabled={purchaseIsUnsafe(operation)}
            key={operation}
            onClick={() => {
              setSelected(operation);
              setReason('');
              setConfirmed(false);
              setMessage('');
            }}
          >
            {operationMetadata[operation].label}
          </Button>
        ))}
      </div>
      {message ? <Text role="status">{message}</Text> : null}
      <Dialog
        open={selected !== undefined}
        onOpenChange={(_e, data) => {
          if (!data.open && !pending) setSelected(undefined);
        }}
      >
        <DialogSurface>
          <DialogBody>
            <DialogTitle>确认任务操作</DialogTitle>
            <DialogContent>
              <Text>{selectedPreview?.impact ?? '权威影响预览不可用，禁止操作。'}</Text>
              <Field label="操作原因">
                <Input
                  aria-label="操作原因"
                  maxLength={200}
                  onChange={(_e, data) => {
                    setReason(data.value);
                  }}
                  value={reason}
                />
              </Field>
              <Checkbox
                checked={confirmed}
                label="我确认执行任务操作"
                onChange={(_e, data) => {
                  setConfirmed(data.checked === true);
                }}
              />
            </DialogContent>
            <DialogActions>
              <Button
                disabled={pending}
                onClick={() => {
                  setSelected(undefined);
                }}
              >
                返回
              </Button>
              <Button
                appearance="primary"
                disabled={!selectedPreview || !confirmed || reason.trim().length === 0 || pending}
                onClick={() => {
                  void submit();
                }}
              >
                确认执行
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}

type TaskOperationsPanelProps = Readonly<{
  onLoadRaw?: () => Promise<Readonly<{ request: unknown; response: unknown }>>;
  permissions: readonly string[];
  task: TaskDetail;
}>;
export function TaskOperationsPanel({ onLoadRaw, permissions, task }: TaskOperationsPanelProps) {
  const styles = useStyles();
  const [tab, setTab] = useState<'PUBLIC' | 'RAW'>('PUBLIC');
  const canRaw = permitted(permissions, 'tasks:raw-read');
  const [raw, setRaw] = useState(task.rawExchange);
  const [rawPending, setRawPending] = useState(false);
  const [rawError, setRawError] = useState('');
  const effectiveTab = canRaw ? tab : 'PUBLIC';
  async function selectTab(value: unknown) {
    const selectedTab = value === 'RAW' ? 'RAW' : 'PUBLIC';
    setTab(selectedTab);
    if (selectedTab !== 'RAW' || raw !== undefined || !onLoadRaw || rawPending) return;
    setRawPending(true);
    setRawError('');
    try {
      setRaw(await onLoadRaw());
    } catch {
      setRawError('脱敏原始报文暂不可用');
    } finally {
      setRawPending(false);
    }
  }
  return (
    <section aria-label="任务运营详情">
      <TabList
        selectedValue={effectiveTab}
        onTabSelect={(_e, data) => {
          void selectTab(data.value);
        }}
      >
        <Tab value="PUBLIC">公开视图</Tab>
        {canRaw ? <Tab value="RAW">原始报文</Tab> : null}
      </TabList>
      {effectiveTab === 'RAW' ? (
        rawPending ? (
          <Text role="status">正在按需读取并脱敏原始报文…</Text>
        ) : rawError ? (
          <Text role="alert">{rawError}</Text>
        ) : (
          <pre aria-label="脱敏原始报文" className={styles.raw}>
            {JSON.stringify(redactRawPayload(raw ?? { unavailable: true }), null, 2)}
          </pre>
        )
      ) : (
        <>
          <div className={styles.cards}>
            <div className={styles.card}>
              <Text weight="semibold">任务快照</Text>
              <br />
              <Badge>{task.status}</Badge>
              <br />
              <Text>
                {task.userIdMasked} · v{String(task.version)}
              </Text>
              <br />
              <Text>更新时间 {task.sourceUpdatedAt}</Text>
            </div>
            <div className={styles.card}>
              <Text weight="semibold">队列</Text>
              <br />
              <Text>
                {task.queue
                  ? `${task.queue.shard} · 优先级 ${String(task.queue.priority)} · ${task.queue.enqueuedAt}`
                  : '未在队列中'}
              </Text>
            </div>
            <div className={styles.card}>
              <Text weight="semibold">供应商尝试 / 熔断</Text>
              <br />
              <Text>
                {task.attempt.providerName} · 第 {String(task.attempt.number)} 次 ·{' '}
                {task.attempt.acceptance}
              </Text>
              <br />
              <Badge>{task.attempt.circuitState}</Badge>{' '}
              <Text>{task.attempt.externalTaskIdMasked ?? '无外部任务号'}</Text>
            </div>
            <div className={styles.card}>
              <Text weight="semibold">财务影响</Text>
              <br />
              <Text>
                冻结 {formatPoints(task.financial.frozenPoints)} · 消费{' '}
                {formatPoints(task.financial.chargedPoints)} · 成本{' '}
                {formatPoints(task.financial.costPoints)} · 退款{' '}
                {formatPoints(task.financial.refundedPoints)}
              </Text>
            </div>
          </div>
          {task.publicError ? <Text role="alert">{task.publicError}</Text> : null}
          <Table aria-label="任务状态时间线">
            <TableHeader>
              <TableRow>
                <TableHeaderCell>时间</TableHeaderCell>
                <TableHeaderCell>事件</TableHeaderCell>
                <TableHeaderCell>说明</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {task.timeline.map((item) => (
                <TableRow key={`${item.at}-${item.code}`}>
                  <TableCell>{item.at}</TableCell>
                  <TableCell>{item.code}</TableCell>
                  <TableCell>{item.label}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {task.attemptHistory ? (
            <Table aria-label="供应商尝试历史">
              <TableHeader>
                <TableRow>
                  <TableHeaderCell>次数 / 时间</TableHeaderCell>
                  <TableHeaderCell>供应商</TableHeaderCell>
                  <TableHeaderCell>受理状态</TableHeaderCell>
                  <TableHeaderCell>标准化结果</TableHeaderCell>
                </TableRow>
              </TableHeader>
              <TableBody>
                {task.attemptHistory.map((attempt) => (
                  <TableRow key={`${String(attempt.number)}-${attempt.at}`}>
                    <TableCell>
                      {String(attempt.number)} · {attempt.at}
                    </TableCell>
                    <TableCell>{attempt.providerName}</TableCell>
                    <TableCell>{attempt.acceptance}</TableCell>
                    <TableCell>{attempt.outcome}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : null}
          {task.normalizedProviderResponse ? (
            <div className={styles.card}>
              <Text weight="semibold">标准化供应商响应</Text>
              <br />
              <Text>
                {task.normalizedProviderResponse.status} · {task.normalizedProviderResponse.code} ·{' '}
                {task.normalizedProviderResponse.message}
              </Text>
            </div>
          ) : null}
          <details>
            <summary>参数快照（公开字段）</summary>
            <pre className={styles.raw}>
              {JSON.stringify(redactRawPayload(task.parameterSnapshot), null, 2)}
            </pre>
          </details>
        </>
      )}
    </section>
  );
}
