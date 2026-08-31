'use client';

import {
  Badge,
  Button,
  Checkbox,
  Field,
  Input,
  Tab,
  TabList,
  Text,
  Title2,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { UserDetailTab, UserDetailView, UserIdentityStatus } from '../lib/user-detail-view-loader';
import type { WalletAdjustmentPreview } from '../lib/user-operation-actions';
import { createUuidV7, isUuidV7 } from '../lib/uuid-v7';
import { AdjustmentDialog } from './adjustment-dialog';

export type UserDetailProps = Readonly<{
  view: UserDetailView;
  onAdjustmentPreview?: (formData: FormData) => Promise<WalletAdjustmentPreview>;
  onAdjustmentRequest?: (formData: FormData) => Promise<Readonly<{ auditRecordId: string; ok: true; requestId: string; status: 'PENDING_APPROVAL' }>>;
  onStatusChange?: (formData: FormData) => Promise<Readonly<{ auditRecordId: string; ok: true; requestId: string }>>;
}>;

const useStyles = makeStyles({
  root: { display: 'grid', gap: '16px' },
  header: {
    alignItems: 'center',
    display: 'flex',
    flexWrap: 'wrap',
    gap: '8px',
    justifyContent: 'space-between',
  },
  identity: { display: 'grid', gap: '4px' },
  sensitive: { color: tokens.colorNeutralForeground3 },
  content: {
    border: `1px solid ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusMedium,
    padding: '16px',
  },
});

const labels = { account: '账户与会话', tasks: '任务', wallet: '钱包', orders: '订单', tickets: '工单', audit: '审计' } as const;

function TabContent({ tab }: Readonly<{ tab: UserDetailTab }>) {
  if (tab.status === 'ERROR') return <Text role="alert">此分区暂时不可用</Text>;
  if (tab.status === 'EMPTY') return <Text>暂无数据</Text>;
  if (tab.id === 'account') return <><section aria-label="账户信息"><dl><dt>显示名称</dt><dd>{tab.account.displayName}</dd><dt>手机号</dt><dd>{tab.account.phoneMasked}</dd><dt>账户状态</dt><dd>{tab.account.status}</dd><dt>注册来源</dt><dd>{tab.account.registrationSource}</dd><dt>消费等级</dt><dd>{tab.account.spendingTier}</dd><dt>标签</dt><dd>{tab.account.tags.join('、')}</dd><dt>创建时间</dt><dd>{tab.account.createdAt}</dd><dt>会话状态</dt><dd>{tab.session.status}</dd><dt>最近活跃</dt><dd>{tab.session.lastActiveAt}</dd></dl></section><section aria-label="登录设备"><Title2 as="h3">登录设备</Title2><table><thead><tr><th>设备</th><th>平台</th><th>状态</th><th>最近活跃</th></tr></thead><tbody>{tab.session.devices.map((device) => <tr key={device.id}><td>{device.id}</td><td>{device.platform}</td><td>{device.status}</td><td>{device.lastSeenAt}</td></tr>)}</tbody></table></section><section aria-label="登录记录"><Title2 as="h3">登录记录</Title2><table><thead><tr><th>设备</th><th>状态</th><th>时间</th></tr></thead><tbody>{tab.session.loginRecords.map((record) => <tr key={record.id}><td>{record.deviceLabel}</td><td>{record.status}</td><td>{record.occurredAt}</td></tr>)}</tbody></table></section></>;
  if (tab.id === 'wallet') { const history = (title: string, entries: readonly { direction: 'CREDIT' | 'DEBIT'; id: string; occurredAt: string; points: string; status: string }[]) => <section aria-label={title}><Title2 as="h3">{title}</Title2><table><thead><tr><th>流水标识</th><th>方向</th><th>点数</th><th>状态</th><th>时间</th></tr></thead><tbody>{entries.map((entry) => <tr key={entry.id}><td>{entry.id}</td><td>{entry.direction}</td><td>{entry.points}</td><td>{entry.status}</td><td>{entry.occurredAt}</td></tr>)}</tbody></table></section>; return <><section aria-label="钱包余额"><dl><dt>可用点数</dt><dd>{tab.balance}</dd><dt>冻结点数</dt><dd>{tab.frozenBalance}</dd><dt>单位</dt><dd>{tab.unit}</dd></dl></section>{history('充值历史', tab.rechargeHistory)}{history('消费历史', tab.consumptionHistory)}{history('调整历史', tab.adjustmentHistory)}</>; }
  if (tab.id === 'audit') return <ul>{tab.items.map((item) => <li key={item.id}>{item.action}（{item.occurredAt}）</li>)}</ul>;
  return <ul>{tab.items.map((item) => <li key={item.id}>{item.id}：{item.status}（{item.createdAt}）</li>)}</ul>;
}

export function UserDetail({
  onAdjustmentPreview,
  onAdjustmentRequest,
  onStatusChange,
  view,
}: UserDetailProps) {
  const styles = useStyles();
  const router = useRouter();
  const [selectedTab, setSelectedTab] = useState(view.tabs[0]?.id);
  const [adjustmentOpen, setAdjustmentOpen] = useState(false);
  const adjustmentTriggerRef = useRef(null);
  const [statusReason, setStatusReason] = useState(''); const [statusConfirmed, setStatusConfirmed] = useState(false); const [statusMessage, setStatusMessage] = useState<string>();
  const [statusIntentId, setStatusIntentId] = useState(() => createUuidV7());
  const [statusPending, setStatusPending] = useState(false);
  const [acceptedFromStatus, setAcceptedFromStatus] = useState<UserIdentityStatus>();
  const statusPendingRef = useRef(false);
  const previousAuthoritativeStatusRef = useRef(view.user.status);
  const activeTab = view.tabs.find((tab) => tab.id === selectedTab) ?? view.tabs[0];
  const authoritativeStatus = view.user.status;
  const statusVersionIsCurrent = previousAuthoritativeStatusRef.current === authoritativeStatus;
  const requestedStatusTransition = authoritativeStatus === 'ACTIVE' ? 'SUSPENDED' : authoritativeStatus === 'SUSPENDED' ? 'ACTIVE' : undefined;
  const awaitingAuthoritativeRefresh = acceptedFromStatus !== undefined && acceptedFromStatus === authoritativeStatus;
  const canRequestStatusChange = Boolean(statusVersionIsCurrent && !awaitingAuthoritativeRefresh && view.canChangeStatus && requestedStatusTransition && view.allowedStatusTransitions?.includes(requestedStatusTransition));

  function closeAdjustmentDialog() {
    setAdjustmentOpen(false);
    (adjustmentTriggerRef.current as HTMLButtonElement | null)?.focus();
  }

  useEffect(() => {
    if (previousAuthoritativeStatusRef.current === authoritativeStatus) return;
    previousAuthoritativeStatusRef.current = authoritativeStatus;
    setAcceptedFromStatus(undefined);
    setStatusConfirmed(false);
    setStatusIntentId(createUuidV7());
    setStatusMessage(undefined);
    setStatusReason('');
  }, [authoritativeStatus]);

  async function submitStatusChange() {
    if (!onStatusChange || activeTab?.id !== 'account' || statusPendingRef.current || awaitingAuthoritativeRefresh) return;
    if (!statusReason.trim() || !statusConfirmed) { setStatusMessage('请填写原因并确认高风险操作'); return; }
    const form = new FormData(); form.set('userId', view.user.id); form.set('currentStatus', authoritativeStatus); form.set('reason', statusReason.trim()); form.set('highRiskConfirmed', 'true'); form.set('intentId', statusIntentId);
    statusPendingRef.current = true; setStatusPending(true);
    try { const result = await onStatusChange(form); if (!isUuidV7(result.auditRecordId) || !isUuidV7(result.requestId)) throw new Error('Invalid authoritative status receipt'); setAcceptedFromStatus(authoritativeStatus); setStatusMessage(`状态变更请求已受理：请求 ${result.requestId}；审计 ${result.auditRecordId}；等待权威状态刷新`); router.refresh(); } catch { setStatusMessage('状态变更被拒绝或暂时不可用'); } finally { statusPendingRef.current = false; setStatusPending(false); }
  }

  return (
    <section aria-labelledby="user-detail-heading" className={styles.root}>
      <div className={styles.header}>
        <div className={styles.identity}>
          <Title2 id="user-detail-heading">{view.user.displayName}</Title2>
          <Text className={styles.sensitive} size={200}>
            {view.user.phoneMasked}
          </Text>
        </div>
        <div>
          <Badge appearance="outline">用户标识已受控</Badge>
          {view.canRequestWalletAdjustment && onAdjustmentPreview && onAdjustmentRequest ? (
            <Button ref={adjustmentTriggerRef} appearance="primary" onClick={() => { setAdjustmentOpen(true); }}>
              调整点数
            </Button>
          ) : null}
          {canRequestStatusChange && onStatusChange && activeTab?.id === 'account' ? <><Button appearance="secondary" disabled={statusPending} onClick={() => { void submitStatusChange(); }}>{authoritativeStatus === 'ACTIVE' ? '封禁用户' : '解封用户'}</Button><Field label="状态变更原因"><Input aria-label="状态变更原因" disabled={statusPending} maxLength={200} value={statusReason} onChange={(_event, data) => { if (data.value !== statusReason) setStatusIntentId(createUuidV7()); setStatusReason(data.value); }} /></Field><Checkbox checked={statusConfirmed} disabled={statusPending} label="我确认这是高风险状态变更" onChange={(_event, data) => { setStatusConfirmed(Boolean(data.checked)); }} /></> : null}
          {statusMessage ? <Text role="status">{statusMessage}</Text> : null}
        </div>
      </div>
      <TabList aria-label="用户详情分区" selectedValue={activeTab?.id}>
        {view.tabs.map((tab) => (
          <Tab aria-controls={`user-detail-panel-${tab.id}`} id={`user-detail-tab-${tab.id}`} key={tab.id} onClick={() => { setSelectedTab(tab.id); }} value={tab.id}>
            {labels[tab.id]}
          </Tab>
        ))}
      </TabList>
      {activeTab ? <div aria-labelledby={`user-detail-tab-${activeTab.id}`} className={styles.content} id={`user-detail-panel-${activeTab.id}`} role="tabpanel"><TabContent tab={activeTab} /></div> : <Text role="status">暂无获授权的详情分区</Text>}
      {adjustmentOpen && onAdjustmentPreview && onAdjustmentRequest ? <AdjustmentDialog {...(view.currentActorId ? { currentActorId: view.currentActorId } : {})} {...(view.eligibleApprovers ? { eligibleApprovers: view.eligibleApprovers } : {})} open userId={view.user.id} onOpenChange={(nextOpen) => { if (!nextOpen) closeAdjustmentDialog(); }} onPreview={onAdjustmentPreview} onRequest={onAdjustmentRequest} /> : null}
    </section>
  );
}
