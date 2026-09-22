import { Text, Title2 } from '@fluentui/react-components';

import { UserDetail } from '../../../../components/user-detail';
import {
  approveWalletAdjustmentAction,
  previewWalletAdjustmentAction,
  previewWalletAdjustmentApprovalAction,
  requestUserStatusChangeAction,
  requestWalletAdjustmentAction,
} from '../actions';
import { createHttpUserOperationPorts } from '../../../../lib/http-user-operation-port';
import { loadUserDetailView, type UserDetailPort } from '../../../../lib/user-detail-view-loader';
import type { ServerGuardContext } from '../../../../lib/server-guard';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type UserDetailPageProps = Readonly<{
  params: Promise<Readonly<{ id: string }>>;
}>;

function DetailError({
  code,
}: Readonly<{ code: 'INVALID_ID' | 'FORBIDDEN' | 'NOT_FOUND' | 'DEPENDENCY' }>) {
  const content = {
    DEPENDENCY: ['503 · 依赖服务错误', '依赖服务未能提供可验证的用户详情。'],
    FORBIDDEN: ['403 · 无权查看此用户', '当前管理员权限或数据范围不允许查看此用户。'],
    INVALID_ID: ['400 · 无效的用户标识', '请求的用户标识格式无效。'],
    NOT_FOUND: ['404 · 用户不存在', '权威服务未找到该用户。'],
  } as const;
  const [title, message] = content[code];
  return (
    <section aria-labelledby="user-detail-error-heading">
      <Title2 id="user-detail-error-heading">{title}</Title2>
      <Text role="alert">{message}</Text>
    </section>
  );
}

export async function renderUserDetailRoute(
  userId: string,
  dependencies: Readonly<{ context?: ServerGuardContext; port: UserDetailPort }>,
) {
  const result = await loadUserDetailView(userId, dependencies);
  return result.ok ? (
    <UserDetail
      view={result.view}
      onAdjustmentPreview={previewWalletAdjustmentAction}
      onAdjustmentRequest={requestWalletAdjustmentAction}
      onApprovalPreview={previewWalletAdjustmentApprovalAction}
      onApproveAdjustment={approveWalletAdjustmentAction}
      onStatusChange={requestUserStatusChangeAction}
    />
  ) : (
    <DetailError code={result.code} />
  );
}

export default async function UserDetailPage({ params }: UserDetailPageProps) {
  const { id } = await params;
  try {
    return await renderUserDetailRoute(id, {
      port: createHttpUserOperationPorts().detailPort,
    });
  } catch {
    return <DetailError code="DEPENDENCY" />;
  }
}
