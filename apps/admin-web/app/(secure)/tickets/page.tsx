import { Button, Field, Input, Link, Select } from '@fluentui/react-components';

import { TicketConsole } from '../../../components/governance/governance-console';
import {
  loadTicketDirectory,
  type GovernanceOperationsPort,
} from '../../../lib/governance-operations';
import { createHttpGovernanceOperationsPort } from '../../../lib/http-governance-port';
import { requireAdminAuthorization, type ServerGuardContext } from '../../../lib/server-guard';
import { addTicketMessage, transitionTicket } from '../governance-actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderTicketsPage(
  dependencies: Readonly<{
    context?: ServerGuardContext;
    cursor?: string;
    port: GovernanceOperationsPort;
    query?: string;
    status?: string;
  }>,
) {
  const [authorization, view] = await Promise.all([
    requireAdminAuthorization('tickets:read', dependencies.context),
    loadTicketDirectory(dependencies),
  ]);
  return (
    <>
      <form method="get">
        <Field label="工单 / 用户">
          <Input defaultValue={dependencies.query ?? ''} name="query" />
        </Field>
        <Field label="状态">
          <Select defaultValue={dependencies.status ?? ''} name="status">
            <option value="">全部</option>
            <option value="OPEN">待处理</option>
            <option value="IN_PROGRESS">处理中</option>
            <option value="RESOLVED">已解决</option>
            <option value="CLOSED">已关闭</option>
          </Select>
        </Field>
        <Button type="submit">检索工单</Button>
      </form>
      <TicketConsole
        onMessage={addTicketMessage}
        onTransition={transitionTicket}
        permissions={authorization.claims.permissions}
        view={view}
      />
      {view.nextCursor ? (
        <Link href={`/tickets?cursor=${encodeURIComponent(view.nextCursor)}`}>下一页</Link>
      ) : null}
    </>
  );
}

export default async function TicketsPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<{ cursor?: string; query?: string; status?: string }>;
}>) {
  return renderTicketsPage({ ...(await searchParams), port: createHttpGovernanceOperationsPort() });
}
