'use client';

import { useMemo, useState } from 'react';

import { createInvoiceAction } from '../../app/commerce-actions';
import {
  classifyCommerceCommandError,
  formatChinaDate,
  formatMinorAmount,
  formatPoints,
} from '../../lib/commerce/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { CommerceGateway, InvoiceCandidatePage } from '../../lib/commerce/types';

const statusLabels = {
  SUBMITTED: '已提交',
  REVIEWING: '审核中',
  APPROVED: '已通过',
  ISSUED: '已开票',
  REJECTED: '已驳回',
} as const;

export function InvoiceCenter({
  initial,
  gateway,
  ownerId,
}: {
  readonly initial: InvoiceCandidatePage;
  readonly gateway?: CommerceGateway;
  readonly ownerId?: string;
}) {
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [title, setTitle] = useState('');
  const [taxNumber, setTaxNumber] = useState('');
  const [email, setEmail] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'status' | 'alert'; message: string }>();
  const selectedCandidates = useMemo(
    () => initial.items.filter((item) => selected.has(item.orderId)),
    [initial.items, selected],
  );
  const totalMinor = selectedCandidates
    .reduce((total, item) => total + BigInt(item.amountMinor), 0n)
    .toString();

  const validate = (): boolean => {
    if (selectedCandidates.length === 0) {
      setFeedback({ tone: 'alert', message: '请至少选择一笔可开票订单。' });
      return false;
    }
    if (title.trim().length < 2 || title.length > 100) {
      setFeedback({ tone: 'alert', message: '发票抬头应为 2–100 个字符。' });
      return false;
    }
    if (!/^[0-9A-Z]{15,20}$/.test(taxNumber)) {
      setFeedback({ tone: 'alert', message: '请输入 15–20 位大写字母或数字纳税人识别号。' });
      return false;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      setFeedback({ tone: 'alert', message: '请输入有效的接收邮箱。' });
      return false;
    }
    setFeedback(undefined);
    return true;
  };

  const submit = async () => {
    if (pending || !validate()) return;
    setPending(true);
    const input = {
      orderIds: selectedCandidates.map((item) => item.orderId),
      title: title.trim(),
      taxNumber,
      email,
    };
    try {
      const raw = gateway
        ? await gateway.createInvoice(input, {
            idempotencyKey: createUuidV7(),
            ownerId: ownerId ?? '',
          })
        : await createInvoiceAction(input, createUuidV7()).then((result) => {
            if (!result.ok)
              throw Object.assign(new Error(result.outcome), { outcome: result.outcome });
            return result.data;
          });
      if (
        typeof raw !== 'object' ||
        raw === null ||
        !('id' in raw) ||
        typeof raw.id !== 'string' ||
        !('status' in raw) ||
        raw.status !== 'SUBMITTED'
      )
        throw new Error('INVALID_INVOICE_RESULT');
      setConfirming(false);
      setSelected(new Set());
      setFeedback({ tone: 'status', message: '发票申请已提交，可在状态历史中跟踪进度。' });
    } catch (error) {
      const uncertain = classifyCommerceCommandError(error) === 'UNCERTAIN';
      setConfirming(false);
      setFeedback({
        tone: 'alert',
        message: uncertain
          ? '申请结果待确认，请刷新开票记录后再操作，避免重复申请。'
          : '申请未提交。订单可能已被开票，请刷新后重新选择。',
      });
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <section className="invoice-application" aria-labelledby="invoice-apply-title">
        <div className="commerce-section-heading">
          <div>
            <p className="section-kicker">申请开票</p>
            <h2 id="invoice-apply-title">选择可开票订单</h2>
            <p>这里只显示服务端判定为已支付且未开票的金额，提交时仍会再次核验。</p>
          </div>
          <strong className="invoice-total">合计 {formatMinorAmount(totalMinor, 'CNY')}</strong>
        </div>
        {initial.items.length === 0 ? (
          <div className="commerce-empty" role="status">
            <h3>暂无可开票金额</h3>
            <p>已支付订单通过资格核验后会显示在这里。</p>
          </div>
        ) : (
          <div className="invoice-candidates">
            {initial.items.map((item) => (
              <label key={item.orderId}>
                <input
                  type="checkbox"
                  checked={selected.has(item.orderId)}
                  disabled={pending}
                  onChange={(event) => {
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(item.orderId);
                      else next.delete(item.orderId);
                      return next;
                    });
                  }}
                />
                <span>
                  <strong>{formatMinorAmount(item.amountMinor, item.currency)}</strong>
                  <small>
                    {formatPoints(item.points)} 点 · 支付于 {formatChinaDate(item.paidAt)}
                  </small>
                </span>
              </label>
            ))}
          </div>
        )}
        <div className="invoice-form-grid">
          <label className="form-field" htmlFor="invoice-title">
            发票抬头
            <input
              id="invoice-title"
              value={title}
              maxLength={100}
              autoComplete="organization"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          </label>
          <label className="form-field" htmlFor="tax-number">
            纳税人识别号
            <input
              id="tax-number"
              value={taxNumber}
              maxLength={20}
              autoCapitalize="characters"
              onChange={(event) => {
                setTaxNumber(event.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''));
              }}
            />
          </label>
          <label className="form-field" htmlFor="invoice-email">
            接收邮箱
            <input
              id="invoice-email"
              type="email"
              value={email}
              maxLength={254}
              autoComplete="email"
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          </label>
        </div>
        {feedback ? (
          <p
            className={`commerce-feedback ${feedback.tone === 'alert' ? 'is-error' : ''}`}
            role={feedback.tone}
            aria-live="polite"
          >
            {feedback.message}
          </p>
        ) : null}
        <button
          type="button"
          disabled={pending || initial.items.length === 0}
          onClick={() => {
            if (validate()) setConfirming(true);
          }}
        >
          核对开票信息
        </button>
      </section>

      <section className="commerce-section" aria-labelledby="invoice-history-title">
        <div className="commerce-section-heading">
          <div>
            <p className="section-kicker">开票记录</p>
            <h2 id="invoice-history-title">状态历史</h2>
          </div>
        </div>
        {initial.history.length === 0 ? (
          <div className="commerce-empty" role="status">
            <h3>尚无开票记录</h3>
            <p>提交申请后，审核和开票进度会按时间保留。</p>
          </div>
        ) : (
          <div className="invoice-history">
            {initial.history.map((invoice) => (
              <article key={invoice.id}>
                <header>
                  <div>
                    <span className="status-chip">{statusLabels[invoice.status]}</span>
                    <h3>{invoice.title}</h3>
                  </div>
                  <strong>{formatMinorAmount(invoice.amountMinor, invoice.currency)}</strong>
                </header>
                <ol>
                  {invoice.statusHistory.map((item, index) => (
                    <li key={`${item.status}-${item.occurredAt}-${String(index)}`}>
                      <strong>{statusLabels[item.status]}</strong>
                      <time dateTime={item.occurredAt}>{formatChinaDate(item.occurredAt)}</time>
                      {item.note ? <p>{item.note}</p> : null}
                    </li>
                  ))}
                </ol>
              </article>
            ))}
          </div>
        )}
      </section>

      {confirming ? (
        <div className="dialog-backdrop">
          <section
            className="commerce-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="invoice-confirm-title"
          >
            <p className="section-kicker">提交前确认</p>
            <h2 id="invoice-confirm-title">确认发票信息</h2>
            <dl className="confirmation-list">
              <div>
                <dt>开票金额</dt>
                <dd>{formatMinorAmount(totalMinor, 'CNY')}</dd>
              </div>
              <div>
                <dt>发票抬头</dt>
                <dd>{title.trim()}</dd>
              </div>
              <div>
                <dt>税号</dt>
                <dd>{taxNumber}</dd>
              </div>
              <div>
                <dt>接收邮箱</dt>
                <dd>{email}</dd>
              </div>
            </dl>
            <p>提交后不能自行修改；订单资格将由服务端再次核验。</p>
            <div className="dialog-actions">
              <button
                type="button"
                className="button-secondary-plain"
                disabled={pending}
                onClick={() => {
                  setConfirming(false);
                }}
              >
                返回修改
              </button>
              <button type="button" disabled={pending} onClick={() => void submit()}>
                {pending ? '正在提交…' : '确认申请'}
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
