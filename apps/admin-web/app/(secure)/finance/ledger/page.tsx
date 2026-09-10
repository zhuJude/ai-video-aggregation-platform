import { Button, Field, Input, Link } from '@fluentui/react-components';

import { LedgerDirectoryView } from '../../../../components/finance/finance-console';
import { FinanceSectionNav } from '../../../../components/finance/finance-section-nav';
import {
  loadLedgerDirectory,
  type FinanceOperationsPort,
} from '../../../../lib/finance-operations';
import { createHttpFinanceOperationsPort } from '../../../../lib/http-finance-port';
import type { ServerGuardContext } from '../../../../lib/server-guard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderFinanceLedgerPage(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    cursor?: string;
    port: FinanceOperationsPort;
    query?: string;
  }>,
) {
  const view = await loadLedgerDirectory(dependencies);
  return (
    <>
      <FinanceSectionNav />
      <form method="get">
        <Field label="事务 ID / 唯一业务键">
          <Input defaultValue={dependencies.query ?? ''} name="query" />
        </Field>
        <Button type="submit">检索账本</Button>
      </form>
      <LedgerDirectoryView view={view} />
      {view.nextCursor ? (
        <Link href={`/finance/ledger?cursor=${encodeURIComponent(view.nextCursor)}`}>下一页</Link>
      ) : null}
    </>
  );
}

export default async function FinanceLedgerPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ cursor?: string; query?: string }> }>) {
  const filters = await searchParams;
  return renderFinanceLedgerPage({ ...filters, port: createHttpFinanceOperationsPort() });
}
