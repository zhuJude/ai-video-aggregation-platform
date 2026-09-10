import { Button, Field, Input, Link, Select } from '@fluentui/react-components';

import { FinanceOrdersView } from '../../../../components/finance/finance-console';
import { FinanceSectionNav } from '../../../../components/finance/finance-section-nav';
import { loadOrderDirectory, type FinanceOperationsPort } from '../../../../lib/finance-operations';
import { createHttpFinanceOperationsPort } from '../../../../lib/http-finance-port';
import type { ServerGuardContext } from '../../../../lib/server-guard';
import { requireAdminAuthorization } from '../../../../lib/server-guard';
import { executeOrderOperation } from '../actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderFinanceOrdersPage(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    cursor?: string;
    port: FinanceOperationsPort;
    query?: string;
    status?: string;
  }>,
) {
  const [authorization, view] = await Promise.all([
    requireAdminAuthorization('finance:read', dependencies.context),
    loadOrderDirectory(dependencies),
  ]);
  return (
    <>
      <FinanceSectionNav />
      <form method="get">
        <Field label="订单号 / 用户标识">
          <Input defaultValue={dependencies.query ?? ''} name="query" />
        </Field>
        <Field label="订单状态">
          <Select defaultValue={dependencies.status ?? ''} name="status">
            <option value="">全部</option>
            <option value="PENDING">待支付</option>
            <option value="PAID">已支付</option>
            <option value="REFUNDING">退款中</option>
            <option value="REFUNDED">已退款</option>
            <option value="FAILED">异常</option>
          </Select>
        </Field>
        <Button type="submit">检索订单</Button>
      </form>
      <FinanceOrdersView
        onOperation={executeOrderOperation}
        permissions={authorization.claims.permissions}
        view={view}
      />
      {view.nextCursor ? (
        <Link href={`/finance/orders?cursor=${encodeURIComponent(view.nextCursor)}`}>下一页</Link>
      ) : null}
    </>
  );
}

export default async function FinanceOrdersPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ cursor?: string; query?: string; status?: string }> }>) {
  const filters = await searchParams;
  return renderFinanceOrdersPage({ ...filters, port: createHttpFinanceOperationsPort() });
}
