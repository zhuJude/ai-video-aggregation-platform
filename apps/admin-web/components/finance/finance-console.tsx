import {
  Button,
  Checkbox,
  Field,
  Input,
  Link,
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
  Text,
  Title2,
  Title3,
} from '@fluentui/react-components';

import {
  invoiceTransitionPermission,
  type InvoiceDirectory,
  type InvoiceTransition,
  type LedgerDirectory,
  type OrderDirectory,
  type OrderOperation,
  type ReconciliationCategory,
  type ReconciliationDirectory,
} from '../../lib/finance-operations';
import { hasPermission } from '../../lib/permissions';
import { createUuidV7 } from '../../lib/uuid-v7';

type FormAction = (form: FormData) => void | Promise<void>;

export function formatIntegerString(value: string): string {
  return BigInt(value).toLocaleString('en-US');
}

function formatFen(value: string): string {
  const amount = BigInt(value);
  const yuan = amount / 100n;
  const fen = (amount % 100n).toString().padStart(2, '0');
  return `¥${yuan.toLocaleString('en-US')}.${fen}`;
}

export function LedgerTotals({ credit, debit }: Readonly<{ credit: string; debit: string }>) {
  return (
    <dl aria-label="账本合计">
      <div>
        <dt>借方合计</dt>
        <dd>{formatIntegerString(debit)}</dd>
      </div>
      <div>
        <dt>贷方合计</dt>
        <dd>{formatIntegerString(credit)}</dd>
      </div>
    </dl>
  );
}

const orderOperationLabels: Readonly<Record<OrderOperation, string>> = Object.freeze({
  CLOSE: '关闭订单',
  REFUND: '发起退款',
  RETRY_REFUND: '重试失败退款',
});

const orderOperationPermissions: Readonly<Record<OrderOperation, string>> = Object.freeze({
  CLOSE: 'finance:order-close',
  REFUND: 'finance:refund-create',
  RETRY_REFUND: 'finance:refund-retry',
});

export function FinanceOrdersView({
  onOperation,
  permissions = [],
  view,
}: Readonly<{
  onOperation?: FormAction;
  permissions?: readonly string[];
  view: OrderDirectory;
}>) {
  return (
    <section aria-labelledby="finance-orders-heading">
      <Title2 as="h2" id="finance-orders-heading">
        充值订单与退款
      </Title2>
      <Text>权威数据时间：{view.sourceUpdatedAt}</Text>
      {view.items.length === 0 ? (
        <Text>当前数据范围内暂无订单</Text>
      ) : (
        view.items.map((order) => (
          <article key={order.id}>
            <Title3 as="h3">订单 {order.id}</Title3>
            <Text>
              {order.userIdMasked} · {formatFen(order.amountFen)} {order.currency} · {order.status}
            </Text>
            <Text>
              支付回调：{order.callbackSummary.status} · 事件 {order.callbackSummary.eventId} ·
              {order.callbackSummary.duplicate ? '重复回调已去重' : '非重复回调'}
            </Text>
            <Text>
              退款：{order.refundSummary.refundId ?? '尚未生成退款号'} · 网关{' '}
              {order.refundSummary.gatewayStatus} · 钱包 {order.refundSummary.walletStatus} ·{' '}
              {formatFen(order.refundSummary.amountFen)}
            </Text>
            {order.exceptionSummary ? (
              <Text role="alert">
                异常：{order.exceptionSummary.code} · {order.exceptionSummary.message} ·{' '}
                {order.exceptionSummary.at}
              </Text>
            ) : null}
            <ol aria-label={`订单 ${order.id} 不可变时间线`}>
              {order.timeline.map((event) => (
                <li key={event.id}>
                  <Text>
                    {event.at} · <span>{event.note}</span> · {event.actor} · Trace {event.traceId}
                  </Text>
                </li>
              ))}
            </ol>
            {order.operationPreviews.map((preview) =>
              order.allowedOperations.includes(preview.operation) &&
              hasPermission({ permissions }, orderOperationPermissions[preview.operation]) &&
              Date.parse(preview.expiresAt) > Date.now() ? (
                <form
                  action={onOperation}
                  aria-label={`${orderOperationLabels[preview.operation]} ${order.id}`}
                  key={preview.operation}
                >
                  <input name="action" type="hidden" value={preview.operation} />
                  <input name="orderId" type="hidden" value={order.id} />
                  <input name="expectedVersion" type="hidden" value={String(order.version)} />
                  <input name="preflightToken" type="hidden" value={preview.preflightToken} />
                  <input name="intentId" type="hidden" value={createUuidV7()} />
                  <Text>{preview.impact}</Text>
                  <Field label="操作原因" required>
                    <Input maxLength={200} name="reason" />
                  </Field>
                  <Checkbox
                    label={`确认${orderOperationLabels[preview.operation]}`}
                    name="confirmed"
                    value="true"
                  />
                  <Button type="submit">{orderOperationLabels[preview.operation]}</Button>
                </form>
              ) : null,
            )}
          </article>
        ))
      )}
    </section>
  );
}

export function LedgerDirectoryView({ view }: Readonly<{ view: LedgerDirectory }>) {
  return (
    <section aria-labelledby="ledger-heading">
      <Title2 as="h2" id="ledger-heading">
        点数总账（只读）
      </Title2>
      <Text>所有更正均通过新分录完成；历史事务不可编辑或删除。</Text>
      <LedgerTotals credit={view.totals.credit} debit={view.totals.debit} />
      {view.items.map((transaction) => (
        <article key={transaction.id}>
          <Title3 as="h3">{transaction.businessKey}</Title3>
          <Text>
            {transaction.createdAt} · Trace {transaction.traceId}
          </Text>
          <Table aria-label={`账本事务 ${transaction.id}`}>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>账户</TableHeaderCell>
                <TableHeaderCell>借方</TableHeaderCell>
                <TableHeaderCell>贷方</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transaction.entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{entry.account}</TableCell>
                  <TableCell>{formatIntegerString(entry.debit)}</TableCell>
                  <TableCell>{formatIntegerString(entry.credit)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </article>
      ))}
    </section>
  );
}

const reconciliationLabels: Readonly<Record<ReconciliationCategory, string>> = Object.freeze({
  AMOUNT_MISMATCH: '金额差异',
  CHANNEL_ONLY: '仅渠道存在',
  PLATFORM_ONLY: '仅平台存在',
  STATUS_MISMATCH: '状态差异',
});

const reconciliationOrder: readonly ReconciliationCategory[] = [
  'PLATFORM_ONLY',
  'CHANNEL_ONLY',
  'AMOUNT_MISMATCH',
  'STATUS_MISMATCH',
];

export function ReconciliationDirectoryView({
  actorId,
  onApproveCompensationRequest,
  onCreateCompensationRequest,
  permissions,
  view,
}: Readonly<{
  onCreateCompensationRequest?: FormAction;
  onApproveCompensationRequest?: FormAction;
  actorId?: string;
  permissions: readonly string[];
  view: ReconciliationDirectory;
}>) {
  return (
    <section aria-labelledby="reconciliation-heading">
      <Title2 as="h2" id="reconciliation-heading">
        渠道对账
      </Title2>
      <Text>权威数据时间：{view.sourceUpdatedAt}</Text>
      {reconciliationOrder.map((category) => {
        const items = view.items.filter((item) => item.category === category);
        return (
          <section aria-labelledby={`reconciliation-${category}`} key={category}>
            <Title3 as="h3" id={`reconciliation-${category}`}>
              {reconciliationLabels[category]}
            </Title3>
            {items.length === 0 ? (
              <Text>无此类差异</Text>
            ) : (
              items.map((item) => {
                const preview = item.repairPreflight;
                const canRequest =
                  item.compensationRequest === null &&
                  item.status !== 'REPAIRED' &&
                  Boolean(preview && Date.parse(preview.expiresAt) > Date.now()) &&
                  hasPermission({ permissions }, 'finance:reconciliation-repair');
                return (
                  <article key={item.id}>
                    <Text>
                      {item.id} · 平台{' '}
                      {item.platformAmountFen === null
                        ? '无记录'
                        : formatFen(item.platformAmountFen)}{' '}
                      / {item.platformStatus ?? '无状态'} · 渠道{' '}
                      {item.channelAmountFen === null ? '无记录' : formatFen(item.channelAmountFen)}{' '}
                      / {item.channelStatus ?? '无状态'}
                    </Text>
                    <Link href={item.runbookPath}>查看对账 Runbook</Link>
                    {item.compensationRequest ? (
                      <Text>
                        补偿申请 {item.compensationRequest.id} · 已完成审批{' '}
                        {String(item.compensationRequest.approvals.length)}/2
                      </Text>
                    ) : null}
                    {canRequest && preview ? (
                      <form
                        action={onCreateCompensationRequest}
                        aria-label={`创建补偿申请 ${item.id}`}
                      >
                        <input name="caseId" type="hidden" value={item.id} />
                        <input name="expectedVersion" type="hidden" value={String(item.version)} />
                        <input name="intentId" type="hidden" value={createUuidV7()} />
                        <input name="preflightToken" type="hidden" value={preview.preflightToken} />
                        <Text>{preview.impact}</Text>
                        <Text>需 2 名不同复核人；申请人不可审批</Text>
                        <Field label="申请原因" required>
                          <Input maxLength={200} name="reason" />
                        </Field>
                        <Checkbox label="确认创建高风险补偿申请" name="confirmed" value="true" />
                        <Button type="submit">创建补偿分录</Button>
                      </form>
                    ) : null}
                    {item.compensationRequest?.allowedApproval &&
                    actorId &&
                    item.compensationRequest.requestedById.toLowerCase() !==
                      actorId.toLowerCase() &&
                    item.compensationRequest.approvals.length < 2 &&
                    !item.compensationRequest.approvals.some(
                      (approval) => approval.approverId.toLowerCase() === actorId.toLowerCase(),
                    ) &&
                    hasPermission({ permissions }, 'finance:reconciliation-approve') ? (
                      <form
                        action={onApproveCompensationRequest}
                        aria-label={`审批补偿申请 ${item.id}`}
                      >
                        <input name="caseId" type="hidden" value={item.id} />
                        <input name="requestId" type="hidden" value={item.compensationRequest.id} />
                        <input name="expectedVersion" type="hidden" value={String(item.version)} />
                        <input name="intentId" type="hidden" value={createUuidV7()} />
                        <input
                          name="preflightToken"
                          type="hidden"
                          value={item.compensationRequest.allowedApproval.preflightToken}
                        />
                        <Text>{item.compensationRequest.allowedApproval.impact}</Text>
                        <Field label="复核意见" required>
                          <Input maxLength={200} name="reason" />
                        </Field>
                        <Checkbox label="确认完成独立复核" name="confirmed" value="true" />
                        <Button type="submit">批准补偿申请</Button>
                      </form>
                    ) : null}
                  </article>
                );
              })
            )}
          </section>
        );
      })}
    </section>
  );
}

const transitionLabels: Readonly<Record<InvoiceTransition, string>> = Object.freeze({
  APPROVED: '审核通过',
  ISSUED: '标记已开票',
  REJECTED: '审核驳回',
});

export function InvoiceDirectoryView({
  onTransition,
  permissions,
  view,
}: Readonly<{
  onTransition?: FormAction;
  permissions: readonly string[];
  view: InvoiceDirectory;
}>) {
  return (
    <section aria-labelledby="invoices-heading">
      <Title2 as="h2" id="invoices-heading">
        发票运营
      </Title2>
      <Text>权威数据时间：{view.sourceUpdatedAt}</Text>
      {view.items.length === 0 ? (
        <Text>当前数据范围内暂无发票申请</Text>
      ) : (
        view.items.map((invoice) => (
          <article key={invoice.id}>
            <Title3 as="h3">{invoice.title}</Title3>
            <Text>
              {invoice.id} · {formatFen(invoice.amountFen)} · {invoice.status}
            </Text>
            <Text>纳税人识别号：{invoice.taxIdentifierMasked}</Text>
            {invoice.certificate ? (
              <Text>
                证书序列号：<span>{invoice.certificate.serialMasked}</span> · 到期：
                {invoice.certificate.expiresAt}
              </Text>
            ) : (
              <Text>未登记开票证书元数据</Text>
            )}
            <ul aria-label={`发票 ${invoice.id} 附件元数据`}>
              {invoice.attachments.map((attachment) => (
                <li key={attachment.fileId}>
                  <span>{attachment.name}</span> · {attachment.mimeType} ·{' '}
                  {String(attachment.sizeBytes)} bytes · {attachment.uploadedAt}
                </li>
              ))}
            </ul>
            {invoice.allowedTransitions.map((preview) =>
              hasPermission({ permissions }, invoiceTransitionPermission[preview.to]) &&
              Date.parse(preview.expiresAt) > Date.now() ? (
                <form
                  action={onTransition}
                  aria-label={`${transitionLabels[preview.to]} ${invoice.id}`}
                  key={preview.to}
                >
                  <input name="invoiceId" type="hidden" value={invoice.id} />
                  <input name="from" type="hidden" value={invoice.status} />
                  <input name="to" type="hidden" value={preview.to} />
                  <input name="expectedVersion" type="hidden" value={String(invoice.version)} />
                  <input name="preflightToken" type="hidden" value={preview.preflightToken} />
                  <input name="intentId" type="hidden" value={createUuidV7()} />
                  <Text>{preview.impact}</Text>
                  {preview.to === 'ISSUED' ? (
                    <>
                      <Field label="证书序列号掩码" required>
                        <Input name="certificateSerialMasked" placeholder="****98AF" />
                      </Field>
                      <Field label="证书到期时间（UTC）" required>
                        <Input name="certificateExpiresAt" placeholder="2027-08-31T00:00:00.000Z" />
                      </Field>
                      <Field label="发票附件文件 ID" required>
                        <Input name="attachmentFileId" />
                      </Field>
                      <Field label="发票附件名称" required>
                        <Input maxLength={200} name="attachmentName" />
                      </Field>
                      <input name="attachmentMimeType" type="hidden" value="application/pdf" />
                      <Field label="发票附件大小（字节）" required>
                        <Input min={1} name="attachmentSizeBytes" type="number" />
                      </Field>
                      <Field label="附件上传时间（UTC）" required>
                        <Input name="attachmentUploadedAt" placeholder="2026-08-31T04:00:00.000Z" />
                      </Field>
                    </>
                  ) : null}
                  <Field label="迁移原因" required>
                    <Input maxLength={200} name="reason" />
                  </Field>
                  <Checkbox
                    label={`确认${transitionLabels[preview.to]}`}
                    name="confirmed"
                    value="true"
                  />
                  <Button type="submit">{transitionLabels[preview.to]}</Button>
                </form>
              ) : null,
            )}
          </article>
        ))
      )}
    </section>
  );
}
