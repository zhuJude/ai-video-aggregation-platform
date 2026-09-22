import { Link } from '@fluentui/react-components';

export function FinanceSectionNav() {
  return (
    <nav aria-label="财务模块导航">
      <Link href="/finance/orders">订单与退款</Link>
      {' · '}
      <Link href="/finance/ledger">点数总账</Link>
      {' · '}
      <Link href="/finance/reconciliation">渠道对账</Link>
      {' · '}
      <Link href="/finance/invoices">发票</Link>
    </nav>
  );
}
