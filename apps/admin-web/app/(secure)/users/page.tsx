import { Link, Table, TableBody, TableCell, TableHeader, TableHeaderCell, TableRow, Text, Title2 } from '@fluentui/react-components';
import { createHttpUserOperationPorts, type UserDirectoryPort } from '../../../lib/http-user-operation-port';
import { loadUsersView } from '../../../lib/user-view-loaders';
import { CsvExportForm, type CsvExportFormProps } from '../../../components/csv-export-form';
import { ExactPhoneLookup, type ExactPhoneLookupProps } from '../../../components/exact-phone-lookup';
import { lookupExactPhoneAction, requestUsersCsvExportAction } from './actions';
import { sanitizeUsersSearchParams, SENSITIVE_QUERY_NOTICE, usersSearchParamsToString } from '../../../lib/sensitive-query';
import { UserDirectorySearchForm } from '../../../components/user-directory-search-form';
import type { ServerGuardContext } from '../../../lib/server-guard';

type UsersPageDependencies = Readonly<{
  context?: ServerGuardContext;
  directoryPort?: UserDirectoryPort;
  onExport?: CsvExportFormProps['onExport'];
  onLookup?: ExactPhoneLookupProps['onLookup'];
}>;

export async function renderUsersPage(params: Record<string, string | string[] | undefined>, dependencies: UsersPageDependencies = {}) {
  const sanitized = sanitizeUsersSearchParams(params);
  const query = sanitized.params.query ?? '';
  const cursor = sanitized.params.cursor;
  const filters = { registrationSource: sanitized.params.registrationSource ?? '', spendingTier: sanitized.params.spendingTier ?? '', status: sanitized.params.status ?? '', tag: sanitized.params.tag ?? '' };
  let view: Awaited<ReturnType<typeof loadUsersView>> | undefined;
  let error: string | undefined;
  try { view = await loadUsersView({ query, filters: { ...(filters.status ? { status: filters.status } : {}), ...(filters.tag ? { tag: filters.tag } : {}), ...(filters.registrationSource ? { registrationSource: filters.registrationSource } : {}), ...(filters.spendingTier ? { spendingTier: filters.spendingTier } : {}) }, ...(cursor ? { cursor } : {}) }, { ...(dependencies.context ? { context: dependencies.context } : {}), directoryPort: dependencies.directoryPort ?? createHttpUserOperationPorts().directoryPort }); } catch { error = '用户目录服务不可用或当前查询未获授权'; }
  if (sanitized.rejected || sanitized.params.notice === SENSITIVE_QUERY_NOTICE) error = '敏感查询参数已移除，请使用受保护的精确手机号查询';
  const filterQuery = usersSearchParamsToString({ query, ...(filters.status ? { status: filters.status } : {}), ...(filters.tag ? { tag: filters.tag } : {}), ...(filters.registrationSource ? { registrationSource: filters.registrationSource } : {}), ...(filters.spendingTier ? { spendingTier: filters.spendingTier } : {}) });
  const showNormalResults = Boolean(view && !sanitized.rejected);
  return <section aria-labelledby="users-heading"><Title2 id="users-heading">用户检索</Title2><UserDirectorySearchForm initialFilters={view?.filters ?? {}} initialQuery={query} />{view?.canUseExactPhone ? <ExactPhoneLookup canExport={view.canExport} onExport={dependencies.onExport ?? requestUsersCsvExportAction} onLookup={dependencies.onLookup ?? lookupExactPhoneAction} /> : null}{showNormalResults && view ? <CsvExportForm canExport={view.canExport} filters={view.filters} key={filterQuery} query={query} onExport={dependencies.onExport ?? requestUsersCsvExportAction} /> : null}{error ? <Text role="alert">{error}</Text> : null}{showNormalResults && view?.items.length === 0 ? <Text>没有匹配用户</Text> : null}{showNormalResults && view ? <Table><TableHeader><TableRow><TableHeaderCell>用户</TableHeaderCell><TableHeaderCell>手机号</TableHeaderCell><TableHeaderCell>账户状态</TableHeaderCell><TableHeaderCell>标签</TableHeaderCell><TableHeaderCell>注册来源</TableHeaderCell><TableHeaderCell>消费等级</TableHeaderCell></TableRow></TableHeader><TableBody>{view.items.map((item) => <TableRow key={item.id}><TableCell><Link href={`/users/${encodeURIComponent(item.id)}`}>{item.displayName}</Link></TableCell><TableCell>{item.phoneMasked}</TableCell><TableCell>{item.status}</TableCell><TableCell>{item.tags?.join('、') ?? '-'}</TableCell><TableCell>{item.registrationSource ?? '-'}</TableCell><TableCell>{item.spendingTier ?? '-'}</TableCell></TableRow>)}</TableBody></Table> : null}{showNormalResults && view?.nextCursor ? <Link href={`/users?${filterQuery}${filterQuery ? '&' : ''}cursor=${encodeURIComponent(view.nextCursor)}`}>下一页</Link> : null}</section>;
}

export default async function UsersPage({ searchParams }: Readonly<{ searchParams: Promise<Record<string, string | string[] | undefined>> }>) {
  return renderUsersPage(await searchParams);
}
