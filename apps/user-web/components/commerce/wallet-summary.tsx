import type { WalletBalanceView } from '../../lib/commerce/types';
import { formatPoints } from '../../lib/commerce/runtime';

export function WalletSummary({ balance }: { readonly balance: WalletBalanceView }) {
  return (
    <dl className="commerce-stat-grid" aria-label="点数余额">
      <div className="commerce-stat commerce-stat-primary">
        <dt>可用点数</dt>
        <dd>{formatPoints(balance.available)}</dd>
        <small>可用于创建新任务</small>
      </div>
      <div className="commerce-stat">
        <dt>冻结点数</dt>
        <dd>{formatPoints(balance.frozen)}</dd>
        <small>任务完成后结算或退回</small>
      </div>
      <div className="commerce-stat">
        <dt>累计充值</dt>
        <dd>{formatPoints(balance.totalRecharged)}</dd>
        <small>含套餐赠送点数</small>
      </div>
      <div className="commerce-stat">
        <dt>累计消费</dt>
        <dd>{formatPoints(balance.totalConsumed)}</dd>
        <small>仅统计已结算任务</small>
      </div>
    </dl>
  );
}
