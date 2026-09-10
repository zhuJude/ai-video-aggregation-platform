import { Button, Field, Link, Select } from '@fluentui/react-components';

import { ReconciliationDirectoryView } from '../../../../components/finance/finance-console';
import { FinanceSectionNav } from '../../../../components/finance/finance-section-nav';
import {
  loadReconciliationDirectory,
  type FinanceOperationsPort,
} from '../../../../lib/finance-operations';
import { createHttpFinanceOperationsPort } from '../../../../lib/http-finance-port';
import { requireAdminAuthorization, type ServerGuardContext } from '../../../../lib/server-guard';
import { approveCompensationRequest, createCompensationRequest } from '../actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderFinanceReconciliationPage(
  dependencies: Readonly<{
    category?: string;
    context?: ServerGuardContext;
    cursor?: string;
    port: FinanceOperationsPort;
    status?: string;
  }>,
) {
  const [authorization, view] = await Promise.all([
    requireAdminAuthorization('finance:read', dependencies.context),
    loadReconciliationDirectory(dependencies),
  ]);
  return (
    <>
      <FinanceSectionNav />
      <form method="get">
        <Field label="差异分类">
          <Select defaultValue={dependencies.category ?? ''} name="category">
            <option value="">全部</option>
            <option value="PLATFORM_ONLY">仅平台存在</option>
            <option value="CHANNEL_ONLY">仅渠道存在</option>
            <option value="AMOUNT_MISMATCH">金额差异</option>
            <option value="STATUS_MISMATCH">状态差异</option>
          </Select>
        </Field>
        <Field label="处理状态">
          <Select defaultValue={dependencies.status ?? ''} name="status">
            <option value="">全部</option>
            <option value="OPEN">待处理</option>
            <option value="INVESTIGATING">调查中</option>
            <option value="REPAIRED">已修复</option>
            <option value="IGNORED">已忽略</option>
          </Select>
        </Field>
        <Button type="submit">筛选差异</Button>
      </form>
      <ReconciliationDirectoryView
        actorId={authorization.claims.subjectId}
        onApproveCompensationRequest={approveCompensationRequest}
        onCreateCompensationRequest={createCompensationRequest}
        permissions={authorization.claims.permissions}
        view={view}
      />
      {view.nextCursor ? (
        <Link href={`/finance/reconciliation?cursor=${encodeURIComponent(view.nextCursor)}`}>
          下一页
        </Link>
      ) : null}
    </>
  );
}

export default async function FinanceReconciliationPage({
  searchParams,
}: Readonly<{ searchParams: Promise<{ category?: string; cursor?: string; status?: string }> }>) {
  const filters = await searchParams;
  return renderFinanceReconciliationPage({
    ...filters,
    port: createHttpFinanceOperationsPort(),
  });
}
