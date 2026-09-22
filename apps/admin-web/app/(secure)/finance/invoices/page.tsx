import { Button, Field, Input, Link, Select } from '@fluentui/react-components';

import { InvoiceDirectoryView } from '../../../../components/finance/finance-console';
import { FinanceSectionNav } from '../../../../components/finance/finance-section-nav';
import {
  loadInvoiceDirectory,
  type FinanceOperationsPort,
} from '../../../../lib/finance-operations';
import { createHttpFinanceOperationsPort } from '../../../../lib/http-finance-port';
import { requireAdminAuthorization, type ServerGuardContext } from '../../../../lib/server-guard';
import { transitionInvoice } from '../actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderFinanceInvoicesPage(
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
    loadInvoiceDirectory(dependencies),
  ]);
  return (
    <>
      <FinanceSectionNav />
      <form method="get">
        <Field label="发票申请 ID / 抬头">
          <Input defaultValue={dependencies.query ?? ''} name="query" />
        </Field>
        <Field label="发票状态">
          <Select defaultValue={dependencies.status ?? ''} name="status">
            <option value="">全部</option>
            <option value="APPLIED">已申请</option>
            <option value="APPROVED">待开票</option>
            <option value="REJECTED">已驳回</option>
            <option value="ISSUED">已开票</option>
          </Select>
        </Field>
        <Button type="submit">检索发票</Button>
      </form>
      <InvoiceDirectoryView
        onTransition={transitionInvoice}
        permissions={authorization.claims.permissions}
        view={view}
      />
      {view.nextCursor ? (
        <Link href={`/finance/invoices?cursor=${encodeURIComponent(view.nextCursor)}`}>下一页</Link>
      ) : null}
    </>
  );
}

export default async function FinanceInvoicesPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ cursor?: string; query?: string; status?: string }> }>) {
  const filters = await searchParams;
  return renderFinanceInvoicesPage({ ...filters, port: createHttpFinanceOperationsPort() });
}
