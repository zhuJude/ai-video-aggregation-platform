'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { createOrderAction } from '../../app/commerce-actions';
import {
  classifyCommerceCommandError,
  formatChinaDate,
  formatMinorAmount,
  formatPoints,
  parseOrderCreateResult,
} from '../../lib/commerce/runtime';
import { createUuidV7 } from '../../lib/tasks/identifiers';
import type { CommerceGateway, OrderCreateResult, OrderPage } from '../../lib/commerce/types';

const orderStatus = {
  PENDING: '待支付',
  PAID: '已支付',
  CLOSED: '已关闭',
  REFUNDED: '已退款',
  FAILED: '支付失败',
} as const;

export function OrderCenter({
  initial,
  gateway,
  ownerId,
}: {
  readonly initial: OrderPage;
  readonly gateway?: CommerceGateway;
  readonly ownerId?: string;
}) {
  const [selection, setSelection] = useState<string>();
  const [customYuan, setCustomYuan] = useState('');
  const [pending, setPending] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [error, setError] = useState<string>();
  const [created, setCreated] = useState<OrderCreateResult>();
  const [paymentClock, setPaymentClock] = useState(() => Date.now());

  useEffect(() => {
    if (!created) return;
    setPaymentClock(Date.now());
    const interval = window.setInterval(() => {
      setPaymentClock(Date.now());
    }, 1_000);
    return () => {
      window.clearInterval(interval);
    };
  }, [created]);

  const paymentActive = created
    ? Date.parse(created.payment.expiresAt) > paymentClock + 5_000
    : false;

  const create = async () => {
    if (pending || uncertain) return;
    setError(undefined);
    let input: { packageId?: string; customAmountMinor?: string };
    if (selection === 'custom') {
      if (!/^\d+(?:\.\d{1,2})?$/.test(customYuan)) {
        setError('请输入有效的人民币金额，最多两位小数。');
        return;
      }
      const [yuan = '0', fraction = ''] = customYuan.split('.');
      const amountMinor = BigInt(yuan) * 100n + BigInt(fraction.padEnd(2, '0'));
      const min = BigInt(initial.customAmount.minMinor);
      const max = BigInt(initial.customAmount.maxMinor);
      const step = BigInt(initial.customAmount.stepMinor);
      if (amountMinor < min || amountMinor > max || amountMinor % step !== 0n) {
        setError(
          `自定义金额须为 ${formatMinorAmount(initial.customAmount.minMinor, 'CNY')}–${formatMinorAmount(initial.customAmount.maxMinor, 'CNY')}，并按整元递增。`,
        );
        return;
      }
      input = { customAmountMinor: amountMinor.toString() };
    } else if (selection) {
      input = { packageId: selection };
    } else {
      setError('请先选择充值档位或自定义金额。');
      return;
    }
    const key = createUuidV7();
    setPending(true);
    try {
      const raw = gateway
        ? await gateway.createOrder(input, { idempotencyKey: key, ownerId: ownerId ?? '' })
        : await createOrderAction(input, key).then((result) => {
            if (!result.ok)
              throw Object.assign(new Error(result.outcome), { outcome: result.outcome });
            return result.data;
          });
      setCreated(parseOrderCreateResult(raw));
    } catch (caught) {
      if (classifyCommerceCommandError(caught) === 'UNCERTAIN') {
        setUncertain(true);
        setError('订单创建结果待确认。请先到订单列表核对，避免重复支付。');
      } else {
        setError('订单未创建，请检查金额后重试。');
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <section className="recharge-panel" aria-labelledby="recharge-title">
        <div className="commerce-section-heading">
          <div>
            <p className="section-kicker">购买点数</p>
            <h2 id="recharge-title">选择充值金额</h2>
            <p>人民币按分精确计价；点数以订单确认页为准。</p>
          </div>
        </div>
        <fieldset className="package-grid">
          <legend className="sr-only">充值档位</legend>
          {initial.packages.map((item) => (
            <label className="package-choice" key={item.id}>
              <input
                type="radio"
                name="package"
                value={item.id}
                checked={selection === item.id}
                disabled={pending || uncertain}
                onChange={() => {
                  setSelection(item.id);
                }}
              />
              <span>
                <strong>{formatMinorAmount(item.amountMinor, item.currency)}</strong>
                <small>{formatPoints(item.points)} 点</small>
              </span>
            </label>
          ))}
          <label className="package-choice package-custom">
            <input
              type="radio"
              name="package"
              value="custom"
              checked={selection === 'custom'}
              disabled={pending || uncertain}
              onChange={() => {
                setSelection('custom');
              }}
            />
            <span>
              <strong>自定义金额</strong>
              <small>{formatMinorAmount(initial.customAmount.minMinor, 'CNY')} 起</small>
            </span>
          </label>
        </fieldset>
        {selection === 'custom' ? (
          <label className="form-field" htmlFor="custom-amount">
            自定义金额（元）
            <input
              id="custom-amount"
              inputMode="decimal"
              value={customYuan}
              onChange={(event) => {
                setCustomYuan(event.target.value);
              }}
              disabled={pending || uncertain}
              aria-describedby="custom-help"
            />
            <small id="custom-help">
              最高 {formatMinorAmount(initial.customAmount.maxMinor, 'CNY')}，仅支持整元充值。
            </small>
          </label>
        ) : null}
        {error ? (
          <p role="alert" className="commerce-feedback is-error">
            {error}
          </p>
        ) : null}
        {uncertain ? (
          <Link className="button-link button-secondary" href="/orders?status=PENDING">
            核对待支付订单
          </Link>
        ) : (
          <button type="button" onClick={() => void create()} disabled={pending}>
            {pending ? '正在创建订单…' : '创建支付订单'}
          </button>
        )}
      </section>

      {created ? (
        <section className="payment-panel" aria-labelledby="payment-title">
          <div>
            <p className="section-kicker">安全支付</p>
            <h2 id="payment-title">微信支付</h2>
            <p>
              订单 {created.order.id.slice(0, 8)}… ·{' '}
              {formatMinorAmount(created.order.amountMinor, created.order.currency)}
            </p>
          </div>
          <div className="payment-action">
            {paymentActive ? (
              <a
                className="button-link button-primary"
                href={created.payment.qrCodeUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                打开微信支付
              </a>
            ) : (
              <strong role="status">支付入口已过期</strong>
            )}
            <small>
              支付入口由服务端白名单载荷生成，不渲染渠道 HTML。
              <br />
              有效至{' '}
              <time dateTime={created.payment.expiresAt}>
                {formatChinaDate(created.payment.expiresAt)}
              </time>
            </small>
          </div>
        </section>
      ) : null}

      <section className="commerce-section" aria-labelledby="orders-title">
        <div className="commerce-section-heading">
          <div>
            <p className="section-kicker">充值记录</p>
            <h2 id="orders-title">订单列表</h2>
          </div>
          <form className="compact-filter" method="get">
            <label htmlFor="order-status">订单状态</label>
            <select id="order-status" name="status">
              <option value="">全部</option>
              {Object.entries(orderStatus).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </select>
            <button type="submit">筛选</button>
          </form>
        </div>
        {initial.items.length === 0 ? (
          <div className="commerce-empty" role="status">
            <h3>暂无充值订单</h3>
            <p>创建订单后可在这里核对支付状态。</p>
          </div>
        ) : (
          <div className="order-list">
            {initial.items.map((order) => (
              <article key={order.id}>
                <div>
                  <span className="status-chip" data-status={order.status}>
                    {orderStatus[order.status]}
                  </span>
                  <h3>{formatMinorAmount(order.amountMinor, order.currency)}</h3>
                  <p>{formatPoints(order.points)} 点</p>
                </div>
                <dl>
                  <div>
                    <dt>创建时间</dt>
                    <dd>
                      <time dateTime={order.createdAt}>{formatChinaDate(order.createdAt)}</time>
                    </dd>
                  </div>
                  {order.status === 'PENDING' && order.expiresAt ? (
                    <div>
                      <dt>支付截止</dt>
                      <dd>
                        <time dateTime={order.expiresAt}>{formatChinaDate(order.expiresAt)}</time>
                      </dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>订单编号</dt>
                    <dd>{order.id}</dd>
                  </div>
                </dl>
                {order.status === 'PENDING' &&
                order.expiresAt &&
                Date.parse(order.expiresAt) > Date.now() ? (
                  <Link href={`/orders?pay=${encodeURIComponent(order.id)}`}>继续支付</Link>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>
    </>
  );
}
