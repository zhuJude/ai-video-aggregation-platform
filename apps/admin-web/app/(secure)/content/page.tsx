import { Button, Field, Link, Select } from '@fluentui/react-components';

import { ContentConsole } from '../../../components/governance/governance-console';
import { loadContentDirectory, type GovernanceOperationsPort } from '../../../lib/governance-operations';
import { createHttpGovernanceOperationsPort } from '../../../lib/http-governance-port';
import { requireAdminAuthorization, type ServerGuardContext } from '../../../lib/server-guard';
import { operateContent, saveContentDraft, validateContentDraft } from '../governance-actions';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function renderContentPage(dependencies: Readonly<{
  context?: ServerGuardContext; cursor?: string; port: GovernanceOperationsPort; status?: string;
}>) {
  const [authorization, view] = await Promise.all([
    requireAdminAuthorization('content:read', dependencies.context),
    loadContentDirectory(dependencies),
  ]);
  return <><form method="get"><Field label="内容状态"><Select defaultValue={dependencies.status ?? ''} name="status"><option value="">全部</option><option value="DRAFT">草稿</option><option value="DRAFT_VALIDATED">已校验</option><option value="PUBLISHED">已发布</option></Select></Field><Button type="submit">筛选内容</Button></form><ContentConsole onOperation={operateContent} onSave={saveContentDraft} onValidate={validateContentDraft} permissions={authorization.claims.permissions} view={view} />{view.nextCursor ? <Link href={`/content?cursor=${encodeURIComponent(view.nextCursor)}`}>下一页</Link> : null}</>;
}

export default async function ContentPage({ searchParams }: Readonly<{
  searchParams: Promise<{ cursor?: string; status?: string }>;
}>) {
  return renderContentPage({ ...await searchParams, port: createHttpGovernanceOperationsPort() });
}
