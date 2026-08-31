import { hasPermission } from './permissions';
import { isSameUuidV7, isUuidV7 } from './uuid-v7';
import { requireAdminAuthorization, type ServerGuardContext } from './server-guard';
import { AuthorizationError } from './session-auth';
import { isMaskedMainlandPhone } from './frozen-scalars';
import { createOutboundRequestContext, parseOutboundRequestContext, type OutboundRequestContext } from './outbound-request-context';

export const USER_DETAIL_TAB_IDS = [
  'account',
  'tasks',
  'wallet',
  'orders',
  'tickets',
  'audit',
] as const;

export type UserDetailTabId = (typeof USER_DETAIL_TAB_IDS)[number];
export type UserDetailTabStatus = 'READY' | 'EMPTY' | 'ERROR';
export type UserIdentityStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type UserTaskStatus = 'QUOTED' | 'RESERVED' | 'QUEUED' | 'SUBMITTING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'EXPIRED' | 'SETTLED' | 'REFUNDED';
export type UserPaymentStatus = 'PENDING' | 'PAID' | 'CLOSED' | 'REFUNDED' | 'FAILED';
export type UserTicketStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED' | 'CLOSED';

type Account = Readonly<{
  createdAt: string;
  displayName: string;
  phoneMasked: string;
  registrationSource: string;
  status: UserIdentityStatus;
  spendingTier: string;
  tags: readonly string[];
}>;

type Session = Readonly<{ devices: readonly Readonly<{ id: string; lastSeenAt: string; platform: string; status: string }>[]; lastActiveAt: string; loginRecords: readonly Readonly<{ deviceLabel: string; id: string; occurredAt: string; status: string }>[]; status: string }>;
type Row<Status extends string> = Readonly<{ createdAt: string; id: string; status: Status }>;
type WalletHistory<Direction extends 'CREDIT' | 'DEBIT'> = Readonly<{ direction: Direction; id: string; occurredAt: string; points: string; status: string }>;
type WalletAdjustmentHistory = WalletHistory<'CREDIT' | 'DEBIT'>;

export type UserDetailTab =
  | Readonly<{ account: Account; id: 'account'; session: Session; status: UserDetailTabStatus }>
  | Readonly<{ id: 'tasks'; items: readonly Row<UserTaskStatus>[]; status: UserDetailTabStatus }>
  | Readonly<{ adjustmentHistory: readonly WalletAdjustmentHistory[]; balance: string; consumptionHistory: readonly WalletHistory<'DEBIT'>[]; frozenBalance: string; id: 'wallet'; rechargeHistory: readonly WalletHistory<'CREDIT'>[]; status: UserDetailTabStatus; unit: 'POINTS' }>
  | Readonly<{ id: 'orders'; items: readonly Row<UserPaymentStatus>[]; status: UserDetailTabStatus }>
  | Readonly<{ id: 'tickets'; items: readonly Row<UserTicketStatus>[]; status: UserDetailTabStatus }>
  | Readonly<{ id: 'audit'; items: readonly Readonly<{ action: string; id: string; occurredAt: string }>[]; status: UserDetailTabStatus }>;

export type UserDetailView = Readonly<{
  allowedStatusTransitions?: readonly Exclude<UserIdentityStatus, 'CLOSED'>[];
  canChangeStatus?: boolean;
  canRequestWalletAdjustment: boolean;
  currentActorId?: string;
  deniedTabs: readonly UserDetailTabId[];
  eligibleApprovers?: readonly Readonly<{ displayName: string; id: string }>[];
  tabs: readonly UserDetailTab[];
  user: Readonly<{ displayName: string; id: string; phoneMasked: string; status: UserIdentityStatus }>;
}>;

const TAB_PERMISSION: Readonly<Record<UserDetailTabId, string>> = {
  account: 'users:read',
  tasks: 'tasks:read',
  wallet: 'finance:read',
  orders: 'finance:read',
  tickets: 'tickets:read',
  audit: 'audit:read',
};

export type UserDetailPort = Readonly<{
  getUserDetail(input: Readonly<{
    requestContext?: OutboundRequestContext;
    trustedSessionToken: string;
    userId: string;
  }>): Promise<UserDetailView>;
}>;

export type UserDetailLoadFailureCode = 'INVALID_ID' | 'FORBIDDEN' | 'NOT_FOUND' | 'DEPENDENCY';

export type UserDetailLoadResult =
  | Readonly<{ code: UserDetailLoadFailureCode; ok: false }>
  | Readonly<{ ok: true; view: UserDetailView }>;

export class UserDetailPortError extends Error {
  constructor(readonly code: Exclude<UserDetailLoadFailureCode, 'INVALID_ID'>) {
    super('Authoritative user detail request failed');
    this.name = 'UserDetailPortError';
  }
}

export function isCanonicalUserId(value: unknown): value is string {
  return isUuidV7(value);
}

export async function loadUserDetailView(
  userId: string,
  dependencies: Readonly<{ context?: ServerGuardContext; createRequestContext?: () => unknown; port: UserDetailPort }>,
): Promise<UserDetailLoadResult> {
  if (!isCanonicalUserId(userId)) {
    return { code: 'INVALID_ID', ok: false };
  }

  let authorization;
  try {
    authorization = await requireAdminAuthorization('users:read', dependencies.context);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { code: 'FORBIDDEN', ok: false };
    }
    return { code: 'DEPENDENCY', ok: false };
  }

  try {
    const requestContext = parseOutboundRequestContext(
      (dependencies.createRequestContext ?? createOutboundRequestContext)(),
    );
    const view = await dependencies.port.getUserDetail({
      requestContext,
      trustedSessionToken: authorization.trustedSessionToken,
      userId,
    });
    const account = view.tabs.find(
      (tab): tab is Extract<UserDetailTab, { id: 'account' }> => tab.id === 'account',
    );
    if (!account || !isMaskedMainlandPhone(view.user.phoneMasked) || !isMaskedMainlandPhone(account.account.phoneMasked) || view.user.phoneMasked !== account.account.phoneMasked || view.user.status !== account.account.status || (view.user as { phone?: unknown }).phone !== undefined || (account.account as { phone?: unknown }).phone !== undefined || !['ACTIVE', 'SUSPENDED', 'CLOSED'].includes(view.user.status)) throw new Error('用户详情响应无效');
    const requiredTransition =
      account.account.status === 'ACTIVE'
        ? 'SUSPENDED'
        : account.account.status === 'SUSPENDED'
          ? 'ACTIVE'
          : undefined;
    const tabs = view.tabs.filter((tab) => hasPermission(authorization.claims, TAB_PERMISSION[tab.id]));
    const deniedTabs = USER_DETAIL_TAB_IDS.filter((id) => !tabs.some((tab) => tab.id === id));
    const walletVisible = tabs.some((tab) => tab.id === 'wallet');
    const canRequestWalletAdjustment = walletVisible && view.canRequestWalletAdjustment && hasPermission(authorization.claims, 'wallet:adjust');
    return {
      ok: true,
      view: {
        ...view,
        tabs,
        deniedTabs,
        canChangeStatus:
          hasPermission(authorization.claims, 'users:status') &&
          Boolean(requiredTransition && view.allowedStatusTransitions?.includes(requiredTransition)),
        canRequestWalletAdjustment,
        currentActorId: authorization.claims.subjectId,
    eligibleApprovers: canRequestWalletAdjustment ? view.eligibleApprovers?.filter((approver) => !isSameUuidV7(approver.id, authorization.claims.subjectId)) ?? [] : [],
      },
    };
  } catch (error) {
    if (error instanceof UserDetailPortError) {
      return { code: error.code, ok: false };
    }
    if (error instanceof Error && error.message === 'FORBIDDEN') {
      return { code: 'FORBIDDEN', ok: false };
    }
    return { code: 'DEPENDENCY', ok: false };
  }
}
