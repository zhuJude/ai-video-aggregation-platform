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
  Text,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useEffect, useRef, useState } from 'react';

import { hasPermission } from '../lib/permissions';
import type {
  ProviderActionReceipt,
  ProviderCommandKind,
  ProviderCredential,
  ProviderCredentialOperationSummary,
  ProviderDetailForClient,
} from '../lib/provider-operations';
import { createUuidV7 } from '../lib/uuid-v7';
import { ProviderMetadataForm } from './provider-metadata-form';

type CommandAction = (formData: FormData) => Promise<ProviderActionReceipt>;

const useStyles = makeStyles({
  root: { display: 'grid', gap: '16px' },
  summary: { display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center' },
  metrics: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: '12px',
  },
  card: {
    backgroundColor: tokens.colorNeutralBackground1,
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '14px',
  },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '8px' },
  definition: {
    display: 'grid',
    gridTemplateColumns: 'max-content minmax(0, 1fr)',
    columnGap: '12px',
    rowGap: '6px',
    margin: 0,
  },
  credential: {
    display: 'grid',
    gap: '8px',
    paddingBlock: '12px',
    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
  },
  dialogFields: { display: 'grid', gap: '12px' },
});

type RiskOperation = Readonly<{ credentialId?: string; kind: ProviderCommandKind; label: string }>;

function OperationDialog({
  onClose,
  onCommand,
  operation,
  providerId,
  version,
}: Readonly<{
  onClose: () => void;
  onCommand: CommandAction;
  operation: RiskOperation;
  providerId: string;
  version: number;
}>) {
  const styles = useStyles();
  const [reason, setReason] = useState('');
  const [replacementSecret, setReplacementSecret] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string>();
  const [intentId, setIntentId] = useState(() => createUuidV7());
  const pendingRef = useRef(false);

  function changeIntent() {
    if (!pendingRef.current) setIntentId(createUuidV7());
    setMessage(undefined);
  }

  async function submit() {
    if (pendingRef.current) return;
    if (!reason.trim()) {
      setMessage('请填写操作原因');
      return;
    }
    if (!confirmed) {
      setMessage('请确认高风险操作');
      return;
    }
    if (operation.kind === 'CREDENTIAL_ROTATE' && replacementSecret.length < 12) {
      setMessage('替换密钥至少 12 个字符');
      return;
    }
    const form = new FormData();
    form.set('kind', operation.kind);
    form.set('providerId', providerId);
    form.set('expectedVersion', String(version));
    form.set('intentId', intentId);
    form.set('reason', reason.trim());
    form.set('confirmed', 'true');
    if (operation.credentialId) form.set('credentialId', operation.credentialId);
    if (operation.kind === 'CREDENTIAL_ROTATE') form.set('replacementSecret', replacementSecret);
    setReplacementSecret('');
    pendingRef.current = true;
    setPending(true);
    setMessage(undefined);
    try {
      const receipt = await onCommand(form);
      setMessage(
        `操作已受理：请求 ${receipt.requestId}；审计 ${receipt.auditRecordId}；等待权威状态刷新`,
      );
    } catch {
      setMessage('操作被拒绝或暂时不可用');
    } finally {
      setReplacementSecret('');
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog
      modalType="modal"
      open
      onOpenChange={(_event, data) => {
        if (!data.open && !pending) onClose();
      }}
    >
      <DialogSurface aria-describedby="provider-operation-description">
        <DialogBody>
          <DialogTitle>{operation.label}</DialogTitle>
          <DialogContent className={styles.dialogFields}>
            <Text id="provider-operation-description">
              该操作将写入审计记录，并以当前权威版本 {version} 执行。
            </Text>
            {operation.kind === 'CREDENTIAL_ROTATE' ? (
              <Field label="替换密钥" required>
                <Input
                  aria-label="替换密钥"
                  autoComplete="new-password"
                  disabled={pending}
                  maxLength={4096}
                  type="password"
                  value={replacementSecret}
                  onChange={(_event, data) => {
                    setReplacementSecret(data.value);
                    changeIntent();
                  }}
                />
              </Field>
            ) : null}
            <Field label="操作原因" required>
              <Input
                aria-label="操作原因"
                disabled={pending}
                maxLength={200}
                value={reason}
                onChange={(_event, data) => {
                  setReason(data.value);
                  changeIntent();
                }}
              />
            </Field>
            <Checkbox
              checked={confirmed}
              disabled={pending}
              label="我确认执行高风险操作"
              onChange={(_event, data) => {
                setConfirmed(Boolean(data.checked));
                changeIntent();
              }}
            />
            {message ? (
              <Text
                role={message.includes('被拒绝') || message.includes('请') ? 'alert' : 'status'}
              >
                {message}
              </Text>
            ) : null}
          </DialogContent>
          <DialogActions>
            <Button disabled={pending} onClick={onClose}>
              取消
            </Button>
            <Button
              appearance="primary"
              disabled={pending}
              onClick={() => {
                void submit();
              }}
            >
              确认提交
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function CredentialPanel({
  canDisable,
  canRead,
  canRotate,
  credentials,
  onSelect,
}: Readonly<{
  canDisable: boolean;
  canRead: boolean;
  canRotate: boolean;
  credentials: readonly (ProviderCredential | ProviderCredentialOperationSummary)[];
  onSelect?: (operation: RiskOperation, trigger: HTMLButtonElement) => void;
  providerId: string;
  version: number;
}>) {
  const styles = useStyles();
  return (
    <section aria-labelledby="provider-credentials-heading" className={styles.card}>
      <Title2 as="h3" id="provider-credentials-heading">
        凭证与 KMS 引用
      </Title2>
      {credentials.length === 0 ? (
        <Text>暂无获授权的凭证元数据</Text>
      ) : (
        credentials.map((credential) => {
          const readable = canRead && 'kmsReference' in credential ? credential : null;
          return (
            <article className={styles.credential} key={credential.id}>
              <Text weight="semibold">
                {readable
                  ? readable.masked
                  : 'label' in credential
                    ? credential.label
                    : '受保护凭证'}
              </Text>
              {readable ? (
                <dl className={styles.definition}>
                  <dt>KMS 引用</dt>
                  <dd>{readable.kmsReference}</dd>
                  <dt>作用范围</dt>
                  <dd>{readable.scope.join('、')}</dd>
                  <dt>状态</dt>
                  <dd>{readable.status}</dd>
                  <dt>轮换时间</dt>
                  <dd>{readable.rotatedAt}</dd>
                  <dt>轮换人</dt>
                  <dd>{readable.rotatedBy}</dd>
                  <dt>最近访问</dt>
                  <dd>
                    {readable.audit.lastAccessedAt} · {readable.audit.lastAccessedBy}
                  </dd>
                </dl>
              ) : (
                <Text>状态：{credential.status}</Text>
              )}
              <div className={styles.actions}>
                {canRotate && credential.status !== 'ROTATING' ? (
                  <Button
                    onClick={(event) =>
                      onSelect?.(
                        {
                          credentialId: credential.id,
                          kind: 'CREDENTIAL_ROTATE',
                          label: '轮换凭证',
                        },
                        event.currentTarget,
                      )
                    }
                  >
                    轮换凭证
                  </Button>
                ) : null}
                {canDisable && credential.status !== 'DISABLED' ? (
                  <Button
                    onClick={(event) =>
                      onSelect?.(
                        {
                          credentialId: credential.id,
                          kind: 'CREDENTIAL_DISABLE',
                          label: '停用凭证',
                        },
                        event.currentTarget,
                      )
                    }
                  >
                    停用凭证
                  </Button>
                ) : null}
              </div>
            </article>
          );
        })
      )}
    </section>
  );
}

export function ProviderDetailConsole({
  onCommand,
  onMetadataSubmit,
  permissions,
  provider,
}: Readonly<{
  onCommand?: CommandAction;
  onMetadataSubmit?: (formData: FormData) => Promise<ProviderActionReceipt>;
  permissions: readonly string[];
  provider: ProviderDetailForClient;
}>) {
  const styles = useStyles();
  const [operation, setOperation] = useState<RiskOperation>();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const previousVersion = useRef(provider.version);
  useEffect(() => {
    if (previousVersion.current !== provider.version) {
      previousVersion.current = provider.version;
      setOperation(undefined);
    }
  }, [provider.version]);
  function select(next: RiskOperation, trigger: HTMLButtonElement) {
    triggerRef.current = trigger;
    setOperation(next);
  }
  function close() {
    setOperation(undefined);
    queueMicrotask(() => {
      triggerRef.current?.focus();
    });
  }
  const can = (permission: string) => hasPermission({ permissions }, permission);
  return (
    <section aria-labelledby="provider-detail-heading" className={styles.root}>
      <div>
        <Title2 as="h2" id="provider-detail-heading">
          {provider.name}
        </Title2>
        <div className={styles.summary}>
          <Badge appearance="outline">{provider.status}</Badge>
          <Badge appearance="tint">{provider.health}</Badge>
          <Badge appearance="outline">熔断 {provider.circuitState}</Badge>
          <Text>来源时间 {provider.sourceUpdatedAt}</Text>
        </div>
      </div>
      <div aria-label="供应商高风险操作" className={styles.actions} role="toolbar">
        {provider.status === 'ENABLED' && can('providers:disable') ? (
          <Button
            onClick={(event) => {
              select({ kind: 'PROVIDER_DISABLE', label: '停用供应商' }, event.currentTarget);
            }}
          >
            停用供应商
          </Button>
        ) : null}
        {provider.status === 'DISABLED' && can('providers:enable') ? (
          <Button
            onClick={(event) => {
              select({ kind: 'PROVIDER_ENABLE', label: '启用供应商' }, event.currentTarget);
            }}
          >
            启用供应商
          </Button>
        ) : null}
        {can('providers:probe') ? (
          <Button
            onClick={(event) => {
              select({ kind: 'HEALTH_PROBE', label: '健康探测' }, event.currentTarget);
            }}
          >
            健康探测
          </Button>
        ) : null}
        {can('providers:circuit-reset') ? (
          <Button
            onClick={(event) => {
              select({ kind: 'CIRCUIT_RESET', label: '重置熔断' }, event.currentTarget);
            }}
          >
            重置熔断
          </Button>
        ) : null}
      </div>
      <div className={styles.metrics}>
        <section className={styles.card} aria-label="接口与鉴权元数据">
          <Title2 as="h3">接口与鉴权</Title2>
          <dl className={styles.definition}>
            <dt>接口</dt>
            <dd>{provider.interface.baseUrl}</dd>
            <dt>协议</dt>
            <dd>{provider.interface.protocol}</dd>
            <dt>超时</dt>
            <dd>{provider.interface.timeoutMs} ms</dd>
            <dt>鉴权方式</dt>
            <dd>{provider.auth.method}</dd>
            <dt>服务身份</dt>
            <dd>{provider.auth.kmsIdentityReference}</dd>
            <dt>回调</dt>
            <dd>
              {provider.callback.mode} · {provider.callback.configured ? '已配置' : '未配置'}
            </dd>
            <dt>回调验签</dt>
            <dd>{provider.callback.verificationKmsReference ?? '无'}</dd>
          </dl>
        </section>
        <section className={styles.card} aria-label="健康与限额">
          <Title2 as="h3">健康与限额</Title2>
          <dl className={styles.definition}>
            <dt>成功率</dt>
            <dd>{(provider.successRateBps / 100).toFixed(2)}%</dd>
            <dt>P95 延迟</dt>
            <dd>{provider.latencyP95Ms} ms</dd>
            <dt>请求限额</dt>
            <dd>
              {provider.rateLimits.requests} / {provider.rateLimits.windowSeconds}s
            </dd>
            <dt>并发</dt>
            <dd>{provider.rateLimits.concurrency}</dd>
            <dt>最近探测</dt>
            <dd>{provider.lastProbe.checkedAt}</dd>
            <dt>探测结果</dt>
            <dd>{provider.lastProbe.message}</dd>
            <dt>Trace</dt>
            <dd>{provider.lastProbe.traceId}</dd>
          </dl>
        </section>
        <section className={styles.card} aria-label="余额与采购">
          <Title2 as="h3">余额与采购</Title2>
          <dl className={styles.definition}>
            <dt>余额</dt>
            <dd>
              {provider.balance.amount} {provider.balance.unit}
            </dd>
            <dt>预警阈值</dt>
            <dd>
              {provider.balance.threshold} {provider.balance.unit}
            </dd>
            <dt>采购折扣</dt>
            <dd>{(provider.procurement.discountBps / 100).toFixed(2)}%</dd>
            <dt>成本单位</dt>
            <dd>{provider.procurement.costUnit}</dd>
          </dl>
        </section>
        <section className={styles.card} aria-label="维护与告警">
          <Title2 as="h3">维护与告警</Title2>
          <dl className={styles.definition}>
            <dt>负责人</dt>
            <dd>{provider.alert.owner}</dd>
            <dt>告警渠道</dt>
            <dd>{provider.alert.channels.join('、')}</dd>
            <dt>维护窗口</dt>
            <dd>
              {provider.maintenanceWindow
                ? `${provider.maintenanceWindow.startsAt} — ${provider.maintenanceWindow.endsAt}`
                : '无'}
            </dd>
            <dt>维护原因</dt>
            <dd>{provider.maintenanceWindow?.reason ?? '无'}</dd>
          </dl>
        </section>
      </div>
      {can('providers:write') && onMetadataSubmit ? (
        <ProviderMetadataForm
          actorId={provider.ownerAdminId ?? ''}
          mode="EDIT"
          onSubmit={onMetadataSubmit}
          provider={provider}
        />
      ) : null}
      {can('credentials:read') || can('credentials:rotate') || can('credentials:disable') ? (
        <CredentialPanel
          canDisable={can('credentials:disable')}
          canRead={can('credentials:read')}
          canRotate={can('credentials:rotate')}
          credentials={provider.credentials}
          onSelect={select}
          providerId={provider.id}
          version={provider.version}
        />
      ) : null}
      {operation && onCommand ? (
        <OperationDialog
          onClose={close}
          onCommand={onCommand}
          operation={operation}
          providerId={provider.id}
          version={provider.version}
        />
      ) : null}
    </section>
  );
}
