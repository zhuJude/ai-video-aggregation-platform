/* eslint-disable @typescript-eslint/require-await -- async fakes model finance BFF calls. */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import {
  FinanceOrdersView,
  InvoiceDirectoryView,
  LedgerDirectoryView,
  LedgerTotals,
  ReconciliationDirectoryView,
} from '../components/finance/finance-console';
import {
  createOrderOperationAction,
  createInvoiceTransitionAction,
  createCompensationApprovalAction,
  createCompensationRequestAction,
  loadOrderDirectory,
  loadReconciliationDirectory,
  parseInvoiceDirectory,
  parseLedgerDirectory,
  parseOrderDirectory,
  parseReconciliationDirectory,
  type FinanceOperationsPort,
} from '../lib/finance-operations';
import { createHttpFinanceOperationsPort } from '../lib/http-finance-port';
import { createOutboundRequestContext } from '../lib/outbound-request-context';
import { signAdminSession } from '../lib/session-auth';
import WalletPaymentRunbookPage from '../app/(secure)/runbooks/wallet-payment/page';

const actorId = '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f';
const reviewerId = '0198f7a4-c6d8-7b39-8a4e-73af0c1d2e3f';
const caseId = '0198f7a4-c6d9-7b39-8a4e-73af0c1d2e3f';
const invoiceId = '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f';
const orderId = '0198f7a4-c6db-7b39-8a4e-73af0c1d2e3f';
const transactionId = '0198f7a4-c6dc-7b39-8a4e-73af0c1d2e3f';
const entryId = '0198f7a4-c6dd-7b39-8a4e-73af0c1d2e3f';
const fileId = '0198f7a4-c6de-7b39-8a4e-73af0c1d2e3f';
const intentId = '0198f7a4-c6df-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c6e0-7b39-8a4e-73af0c1d2e3f';
const auditRecordId = '0198f7a4-c6e1-7b39-8a4e-73af0c1d2e3f';
const signingKey = 'finance-tests-signing-key-at-least-32-bytes';

const orderPayload = {
  items: [
    {
      allowedOperations: [],
      amountFen: '8800',
      assignedAdminIds: [actorId],
      callbackSummary: {
        duplicate: false,
        eventId: 'wx-event-20260831-01',
        status: 'VERIFIED',
        verifiedAt: '2026-08-31T02:00:30.000Z',
      },
      currency: 'CNY',
      exceptionSummary: null,
      id: orderId,
      operationPreviews: [],
      ownerAdminId: actorId,
      refundSummary: {
        amountFen: '8800',
        currency: 'CNY',
        gatewayStatus: 'SUCCEEDED',
        refundId: 'wx-refund-masked-0001',
        walletStatus: 'CREDITED',
      },
      status: 'REFUNDED',
      userIdMasked: 'usr_****2e3f',
      timeline: [
        {
          actor: 'SYSTEM',
          at: '2026-08-31T02:00:00.000Z',
          event: 'ORDER_CREATED',
          id: transactionId,
          note: '平台订单已创建',
          traceId: '0123456789abcdef0123456789abcdef',
        },
        {
          actor: 'WECHAT_PAY',
          at: '2026-08-31T02:01:00.000Z',
          event: 'REFUND_SUCCEEDED',
          id: entryId,
          note: '退款已按新分录入账',
          traceId: '1123456789abcdef0123456789abcdef',
        },
      ],
      version: 5,
    },
  ],
  nextCursor: null,
  sourceUpdatedAt: '2026-08-31T03:00:00.000Z',
} as const;

const refundableOrder = {
  ...orderPayload.items[0],
  allowedOperations: ['REFUND'],
  operationPreviews: [
    {
      expiresAt: '2099-08-31T03:10:00.000Z',
      impact: '创建全额退款请求；退款结果由支付和钱包权威状态推进',
      operation: 'REFUND',
      preflightToken: 'order-preflight-signed-token',
      resultStatus: 'PAID',
    },
  ],
  refundSummary: {
    amountFen: '8800',
    currency: 'CNY',
    gatewayStatus: 'NOT_REQUESTED',
    refundId: null,
    walletStatus: 'NOT_REQUESTED',
  },
  status: 'PAID',
  timeline: [orderPayload.items[0].timeline[0]],
} as const;

const ledgerPayload = {
  items: [
    {
      businessKey: 'refund:wx:20260831:0001',
      createdAt: '2026-08-31T02:01:00.000Z',
      entries: [
        {
          account: 'USER_AVAILABLE',
          credit: '0',
          debit: '9007199254740993',
          id: entryId,
        },
        {
          account: 'PLATFORM_LIABILITY',
          credit: '9007199254740993',
          debit: '0',
          id: transactionId,
        },
      ],
      id: transactionId,
      traceId: '2123456789abcdef0123456789abcdef',
    },
  ],
  nextCursor: null,
  sourceUpdatedAt: '2026-08-31T03:00:00.000Z',
  totals: { credit: '9007199254740993', debit: '9007199254740993' },
} as const;

const reconciliationPayload = {
  items: [
    {
      assignedAdminIds: [actorId],
      category: 'AMOUNT_MISMATCH',
      channelAmountFen: '8800',
      channelStatus: 'SUCCESS',
      compensationRequest: null,
      id: caseId,
      ownerAdminId: actorId,
      platformAmountFen: '8000',
      platformStatus: 'PAID',
      repairPreflight: {
        approvalPolicy: {
          prohibitRequesterApproval: true,
          requiredApprovals: 2,
        },
        expiresAt: '2099-08-31T03:10:00.000Z',
        impact: '新增平衡补偿分录 800 点，不修改任何历史分录',
        preflightToken: 'recon-preflight-signed-token',
      },
      runbookPath: '/runbooks/wallet-payment#reconciliation',
      status: 'OPEN',
      version: 7,
    },
    {
      assignedAdminIds: [actorId],
      category: 'PLATFORM_ONLY',
      channelAmountFen: null,
      channelStatus: null,
      compensationRequest: null,
      id: '0198f7a4-c6e2-7b39-8a4e-73af0c1d2e3f',
      ownerAdminId: actorId,
      platformAmountFen: '100',
      platformStatus: 'PAID',
      repairPreflight: null,
      runbookPath: '/runbooks/wallet-payment#reconciliation',
      status: 'INVESTIGATING',
      version: 2,
    },
  ],
  nextCursor: null,
  sourceUpdatedAt: '2026-08-31T03:00:00.000Z',
} as const;

const invoicePayload = {
  items: [
    {
      allowedTransitions: [
        {
          expiresAt: '2099-08-31T03:10:00.000Z',
          impact: '审核通过后进入待开票队列',
          preflightToken: 'invoice-preflight-signed-token',
          to: 'APPROVED',
        },
      ],
      amountFen: '8800',
      assignedAdminIds: [actorId],
      attachments: [
        {
          fileId,
          mimeType: 'application/pdf',
          name: '开票申请附件.pdf',
          sizeBytes: 4096,
          uploadedAt: '2026-08-31T01:00:00.000Z',
        },
      ],
      certificate: null,
      id: invoiceId,
      ownerAdminId: actorId,
      status: 'APPLIED',
      taxIdentifierMasked: '91************2X',
      title: '示例科技有限公司',
      version: 3,
    },
  ],
  nextCursor: null,
  sourceUpdatedAt: '2026-08-31T03:00:00.000Z',
} as const;

async function session(permissions: readonly string[], subjectId = actorId) {
  return signAdminSession(
    {
      dataScope: 'ALL',
      expiresAt: Date.now() + 60_000,
      permissions,
      sessionInstanceId: intentId,
      subjectId,
    },
    signingKey,
  );
}

async function scopedSession(
  permissions: readonly string[],
  dataScope: 'ALL' | 'ASSIGNED' | 'OWN',
) {
  return signAdminSession(
    {
      dataScope,
      expiresAt: Date.now() + 60_000,
      permissions,
      sessionInstanceId: intentId,
      subjectId: actorId,
    },
    signingKey,
  );
}

describe('finance read models', () => {
  it('does not lose precision for ledger totals', () => {
    render(<LedgerTotals debit="9007199254740993" credit="9007199254740993" />);
    expect(screen.getAllByText('9,007,199,254,740,993')).toHaveLength(2);
  });

  it('renders order and refund history as an immutable timeline', () => {
    render(<FinanceOrdersView view={parseOrderDirectory(orderPayload)} />);
    expect(screen.getByText('平台订单已创建')).toBeVisible();
    expect(screen.getByText('退款已按新分录入账')).toBeVisible();
    expect(screen.queryByRole('button', { name: /编辑|删除/u })).not.toBeInTheDocument();
  });

  it('rejects sensitive material in immutable timeline actor or note', () => {
    for (const note of [
      'Authorization: Bearer top-secret-token',
      'Wechatpay-Signature: leaked-signature',
      'Cookie: admin_session=leaked',
    ]) {
      expect(() =>
        parseOrderDirectory({
          ...orderPayload,
          items: [
            {
              ...orderPayload.items[0],
              timeline: [{ ...orderPayload.items[0].timeline[0], note }],
            },
          ],
        }),
      ).toThrow('订单响应无效');
    }
  });

  it('accepts the WS12 refunding state while awaiting authoritative confirmations', () => {
    expect(
      parseOrderDirectory({
        ...orderPayload,
        items: [
          {
            ...refundableOrder,
            allowedOperations: [],
            operationPreviews: [],
            refundSummary: {
              ...refundableOrder.refundSummary,
              gatewayStatus: 'PENDING',
              refundId: 'wx-refund-masked-0002',
              walletStatus: 'PENDING',
            },
            status: 'REFUNDING',
          },
        ],
      }).items[0]?.status,
    ).toBe('REFUNDING');
  });

  it('never accepts a refunded order before both gateway and wallet confirmation', () => {
    expect(() =>
      parseOrderDirectory({
        ...orderPayload,
        items: [
          {
            ...orderPayload.items[0],
            refundSummary: {
              ...orderPayload.items[0].refundSummary,
              gatewayStatus: 'PENDING',
            },
          },
        ],
      }),
    ).toThrow('订单响应无效');
  });

  it('requires one authoritative preview for every allowed order operation', () => {
    expect(() =>
      parseOrderDirectory({
        ...orderPayload,
        items: [
          {
            ...refundableOrder,
            allowedOperations: ['REFUND', 'CLOSE'],
            operationPreviews: [
              refundableOrder.operationPreviews[0],
              refundableOrder.operationPreviews[0],
            ],
          },
        ],
      }),
    ).toThrow('订单响应无效');
  });

  it('renders a balanced ledger without any edit affordance', () => {
    render(<LedgerDirectoryView view={parseLedgerDirectory(ledgerPayload)} />);
    expect(screen.getByText('refund:wx:20260831:0001')).toBeVisible();
    expect(screen.getAllByText('9,007,199,254,740,993').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('accepts the WS12 adjustment ledger account kind', () => {
    const adjusted = {
      ...ledgerPayload,
      items: [
        {
          ...ledgerPayload.items[0],
          entries: ledgerPayload.items[0].entries.map((entry, index) =>
            index === 0 ? { ...entry, account: 'ADJUSTMENT' } : entry,
          ),
        },
      ],
    };
    expect(parseLedgerDirectory(adjusted).items[0]?.entries[0]?.account).toBe('ADJUSTMENT');
  });

  it('groups mismatch categories and links the reconciliation runbook', () => {
    render(
      <ReconciliationDirectoryView
        permissions={['finance:read']}
        view={parseReconciliationDirectory(reconciliationPayload)}
      />,
    );
    expect(screen.getByRole('heading', { name: '金额差异' })).toBeVisible();
    expect(screen.getByRole('heading', { name: '仅平台存在' })).toBeVisible();
    expect(screen.getAllByRole('link', { name: '查看对账 Runbook' })[0]).toHaveAttribute(
      'href',
      '/runbooks/wallet-payment#reconciliation',
    );
  });

  it('does not expose repair action to a single approver', () => {
    render(
      <ReconciliationDirectoryView
        permissions={['finance:read']}
        view={parseReconciliationDirectory(reconciliationPayload)}
      />,
    );
    expect(screen.queryByRole('button', { name: '创建补偿分录' })).not.toBeInTheDocument();
  });

  it('only renders authoritative reviewed repair previews to repair operators', () => {
    render(
      <ReconciliationDirectoryView
        permissions={['finance:read', 'finance:reconciliation-repair']}
        view={parseReconciliationDirectory(reconciliationPayload)}
      />,
    );
    expect(screen.getByText('需 2 名不同复核人；申请人不可审批')).toBeVisible();
    expect(screen.getByRole('button', { name: '创建补偿分录' })).toBeVisible();
  });

  it('rejects extra financial response properties', () => {
    expect(() => parseLedgerDirectory({ ...ledgerPayload, directBalanceEditor: true })).toThrow(
      '账本响应无效',
    );
  });

  it('rejects attacker-selected runbook destinations', () => {
    expect(() =>
      parseReconciliationDirectory({
        ...reconciliationPayload,
        items: [{ ...reconciliationPayload.items[0], runbookPath: '/runbooks/phishing' }],
      }),
    ).toThrow('对账响应无效');
  });

  it('requires ALL scope before querying global orders', async () => {
    const listOrders = vi.fn();
    await expect(
      loadOrderDirectory({
        context: {
          sessionToken: await scopedSession(['finance:read'], 'OWN'),
          signingKey,
        },
        port: { listOrders } as unknown as FinanceOperationsPort,
      }),
    ).rejects.toThrow('全部数据范围');
    expect(listOrders).not.toHaveBeenCalled();
  });

  it('allows ASSIGNED reconciliation only for explicitly assigned cases', async () => {
    const outside = {
      ...reconciliationPayload.items[0],
      assignedAdminIds: [],
      ownerAdminId: reviewerId,
    };
    await expect(
      loadReconciliationDirectory({
        context: {
          sessionToken: await scopedSession(['finance:read'], 'ASSIGNED'),
          signingKey,
        },
        port: {
          async listReconciliation() {
            return { ...reconciliationPayload, items: [outside] };
          },
        } as unknown as FinanceOperationsPort,
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('serves the statically trusted reconciliation runbook destination', () => {
    render(<WalletPaymentRunbookPage />);
    expect(screen.getByRole('heading', { name: '钱包与支付对账 Runbook' })).toBeVisible();
  });
});

describe('order operations', () => {
  it('does not expose a refund action without its fine-grained permission', () => {
    render(
      <FinanceOrdersView
        permissions={['finance:read']}
        view={parseOrderDirectory({ ...orderPayload, items: [refundableOrder] })}
      />,
    );
    expect(screen.queryByRole('button', { name: '发起退款' })).not.toBeInTheDocument();
  });

  it('re-fetches and binds a refund request without accepting client money fields', async () => {
    const executeOrderOperation = vi.fn(async () => ({
      auditRecordId,
      idempotencyKey: intentId,
      ok: true,
      operation: 'REFUND',
      orderId,
      requestId,
      status: 'PAID',
      version: 6,
    }));
    const action = createOrderOperationAction({
      context: {
        sessionToken: await session(['finance:refund-create']),
        signingKey,
      },
      port: {
        executeOrderOperation,
        async getOrder() {
          return refundableOrder;
        },
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('action', 'REFUND');
    form.set('orderId', orderId);
    form.set('expectedVersion', '5');
    form.set('preflightToken', 'order-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '用户申请原路退款');
    form.set('confirmed', 'true');
    await expect(action(form)).resolves.toMatchObject({ operation: 'REFUND', status: 'PAID' });
    expect(executeOrderOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        expectedVersion: 5,
        operation: 'REFUND',
      }),
    );
    form.set('amountFen', '1');
    await expect(action(form)).rejects.toThrow('订单操作字段无效');
    form.delete('amountFen');
    form.set('reason', 'Wechatpay-Signature: leaked-signature');
    executeOrderOperation.mockClear();
    await expect(action(form)).rejects.toThrow('订单操作字段无效');
    expect(executeOrderOperation).not.toHaveBeenCalled();
  });

  it('rejects an operation receipt for a different order result', async () => {
    const action = createOrderOperationAction({
      context: {
        sessionToken: await session(['finance:refund-create']),
        signingKey,
      },
      port: {
        async executeOrderOperation() {
          return {
            auditRecordId,
            idempotencyKey: intentId,
            ok: true,
            operation: 'CLOSE',
            orderId,
            requestId,
            status: 'CLOSED',
            version: 6,
          };
        },
        async getOrder() {
          return refundableOrder;
        },
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('action', 'REFUND');
    form.set('orderId', orderId);
    form.set('expectedVersion', '5');
    form.set('preflightToken', 'order-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '用户申请原路退款');
    form.set('confirmed', 'true');
    await expect(action(form)).rejects.toThrow('订单操作回执无效');
  });
});

describe('reconciliation repair authorization', () => {
  it('fails closed before reading a case without repair permission', async () => {
    const getReconciliationCase = vi.fn();
    const createCompensationRequest = vi.fn();
    const action = createCompensationRequestAction({
      context: { sessionToken: await session(['finance:read']), signingKey },
      port: {
        getReconciliationCase,
        createCompensationRequest,
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('expectedVersion', '7');
    form.set('preflightToken', 'recon-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '修复渠道金额差异');
    form.set('confirmed', 'true');
    await expect(action(form)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(getReconciliationCase).not.toHaveBeenCalled();
    expect(createCompensationRequest).not.toHaveBeenCalled();
  });

  it('binds repair to scope, version, a distinct reviewer and UUIDv7 idempotency', async () => {
    const createCompensationRequest = vi.fn(async () => ({
      auditRecordId,
      caseId,
      compensationRequestId: requestId,
      idempotencyKey: intentId,
      ok: true,
      operation: 'CREATE_COMPENSATION_REQUEST',
      requestId: '0198f7a4-c6e3-7b39-8a4e-73af0c1d2e3f',
      status: 'PENDING_APPROVAL',
      version: 8,
    }));
    const action = createCompensationRequestAction({
      context: {
        sessionToken: await session(['finance:reconciliation-repair']),
        signingKey,
      },
      port: {
        async getReconciliationCase() {
          return reconciliationPayload.items[0];
        },
        createCompensationRequest,
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('expectedVersion', '7');
    form.set('preflightToken', 'recon-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '修复渠道金额差异');
    form.set('confirmed', 'true');
    await expect(action(form)).resolves.toMatchObject({ ok: true, version: 8 });
    expect(createCompensationRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        audit: { idempotencyKey: intentId, reason: '修复渠道金额差异' },
        expectedVersion: 7,
        preflightToken: 'recon-preflight-signed-token',
        requiredApprovals: 2,
      }),
    );
  });

  it('rejects a degraded dual-review policy and never accepts client amounts', async () => {
    const createCompensationRequest = vi.fn();
    const action = createCompensationRequestAction({
      context: {
        sessionToken: await session(['finance:reconciliation-repair']),
        signingKey,
      },
      port: {
        async getReconciliationCase() {
          return {
            ...reconciliationPayload.items[0],
            repairPreflight: {
              ...reconciliationPayload.items[0].repairPreflight,
              approvalPolicy: {
                prohibitRequesterApproval: false,
                requiredApprovals: 1,
              },
            },
          };
        },
        createCompensationRequest,
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('expectedVersion', '7');
    form.set('preflightToken', 'recon-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '修复渠道金额差异');
    form.set('confirmed', 'true');
    form.set('amount', '999999999999');
    await expect(action(form)).rejects.toThrow('字段无效');
    form.delete('amount');
    await expect(action(form)).rejects.toThrow('对账案例响应无效');
    expect(createCompensationRequest).not.toHaveBeenCalled();
  });

  it('prevents the requester and an existing reviewer from approving a compensation request', async () => {
    const approveCompensationRequest = vi.fn();
    const requestedCase = {
      ...reconciliationPayload.items[0],
      compensationRequest: {
        allowedApproval: {
          expiresAt: '2099-08-31T03:10:00.000Z',
          impact: '第 2 次审批通过后由钱包服务创建新补偿分录',
          preflightToken: 'approval-preflight-signed-token',
          resultStatus: 'PENDING_APPROVAL',
        },
        approvals: [],
        id: requestId,
        requestedById: actorId,
        status: 'PENDING_APPROVAL',
      },
      repairPreflight: null,
    };
    const action = createCompensationApprovalAction({
      context: {
        sessionToken: await session(['finance:reconciliation-approve']),
        signingKey,
      },
      port: {
        approveCompensationRequest,
        async getReconciliationCase() {
          return requestedCase;
        },
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('requestId', requestId);
    form.set('expectedVersion', '7');
    form.set('preflightToken', 'approval-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '核对渠道账单后批准');
    form.set('confirmed', 'true');
    await expect(action(form)).rejects.toThrow('申请人不可审批');
    expect(approveCompensationRequest).not.toHaveBeenCalled();
  });

  it('records a distinct compensation approver through an idempotent optimistic command', async () => {
    const approveCompensationRequest = vi.fn(async () => ({
      auditRecordId,
      caseId,
      compensationRequestId: requestId,
      idempotencyKey: intentId,
      ok: true,
      operation: 'APPROVE_COMPENSATION_REQUEST',
      requestId: '0198f7a4-c6e3-7b39-8a4e-73af0c1d2e3f',
      status: 'PENDING_APPROVAL',
      version: 8,
    }));
    const requestedCase = {
      ...reconciliationPayload.items[0],
      compensationRequest: {
        allowedApproval: {
          expiresAt: '2099-08-31T03:10:00.000Z',
          impact: '第 1 次审批，仅登记审批记录',
          preflightToken: 'approval-preflight-signed-token',
          resultStatus: 'PENDING_APPROVAL',
        },
        approvals: [],
        id: requestId,
        requestedById: actorId,
        status: 'PENDING_APPROVAL',
      },
      repairPreflight: null,
    };
    const action = createCompensationApprovalAction({
      context: {
        sessionToken: await session(['finance:reconciliation-approve'], reviewerId),
        signingKey,
      },
      port: {
        approveCompensationRequest,
        async getReconciliationCase() {
          return requestedCase;
        },
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('requestId', requestId);
    form.set('expectedVersion', '7');
    form.set('preflightToken', 'approval-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '核对渠道账单后批准');
    form.set('confirmed', 'true');
    await expect(action(form)).resolves.toMatchObject({ ok: true, version: 8 });
    expect(approveCompensationRequest).toHaveBeenCalledWith(
      expect.objectContaining({ approverId: reviewerId, expectedVersion: 7, requestId }),
    );
  });

  it('rejects a compensation approval receipt that is not bound to its request and expected status', async () => {
    const requestedCase = {
      ...reconciliationPayload.items[0],
      compensationRequest: {
        allowedApproval: {
          expiresAt: '2099-08-31T03:10:00.000Z',
          impact: '第 1 次审批，仅登记审批记录',
          preflightToken: 'approval-preflight-signed-token',
          resultStatus: 'PENDING_APPROVAL',
        },
        approvals: [],
        id: requestId,
        requestedById: actorId,
        status: 'PENDING_APPROVAL',
      },
      repairPreflight: null,
    };
    const action = createCompensationApprovalAction({
      context: {
        sessionToken: await session(['finance:reconciliation-approve'], reviewerId),
        signingKey,
      },
      port: {
        async approveCompensationRequest() {
          return {
            auditRecordId,
            caseId,
            compensationRequestId: requestId,
            idempotencyKey: intentId,
            ok: true,
            operation: 'APPROVE_COMPENSATION_REQUEST',
            requestId: '0198f7a4-c6e3-7b39-8a4e-73af0c1d2e3f',
            status: 'APPROVED',
            version: 8,
          };
        },
        async getReconciliationCase() {
          return requestedCase;
        },
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('caseId', caseId);
    form.set('requestId', requestId);
    form.set('expectedVersion', '7');
    form.set('preflightToken', 'approval-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '核对渠道账单后批准');
    form.set('confirmed', 'true');
    await expect(action(form)).rejects.toThrow('财务操作回执无效');
  });

  it('requires exactly two approvals for APPROVED and POSTED compensation requests', () => {
    expect(() =>
      parseReconciliationDirectory({
        ...reconciliationPayload,
        items: [
          {
            ...reconciliationPayload.items[0],
            compensationRequest: {
              allowedApproval: null,
              approvals: [],
              id: requestId,
              requestedById: actorId,
              status: 'POSTED',
            },
            repairPreflight: null,
          },
        ],
      }),
    ).toThrow('对账响应无效');
  });
});

describe('invoice workflow', () => {
  it('shows only status transitions covered by fine-grained permission', () => {
    render(
      <InvoiceDirectoryView
        permissions={['finance:invoice-review']}
        view={parseInvoiceDirectory(invoicePayload)}
      />,
    );
    expect(screen.getByRole('button', { name: '审核通过' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '标记已开票' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '作废发票' })).not.toBeInTheDocument();
  });

  it('renders certificate and attachment metadata without tax secrets', () => {
    const issued = {
      ...invoicePayload.items[0],
      allowedTransitions: [],
      certificate: {
        expiresAt: '2027-08-31T00:00:00.000Z',
        serialMasked: '****98AF',
      },
      status: 'ISSUED',
    };
    render(
      <InvoiceDirectoryView
        permissions={['finance:read']}
        view={parseInvoiceDirectory({ ...invoicePayload, items: [issued] })}
      />,
    );
    expect(screen.getByText('****98AF')).toBeVisible();
    expect(screen.getByText('开票申请附件.pdf')).toBeVisible();
    expect(document.body.textContent).not.toContain('91350211M000100Y43');
    expect(document.body.textContent).not.toContain('PRIVATE KEY');
  });

  it('re-authorizes and binds an invoice transition to current state and preflight', async () => {
    const executeInvoiceTransition = vi.fn(async () => ({
      auditRecordId,
      idempotencyKey: intentId,
      invoiceId,
      ok: true,
      requestId,
      status: 'APPROVED',
      version: 4,
    }));
    const action = createInvoiceTransitionAction({
      context: {
        sessionToken: await session(['finance:invoice-review']),
        signingKey,
      },
      port: {
        async getInvoice() {
          return invoicePayload.items[0];
        },
        executeInvoiceTransition,
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('invoiceId', invoiceId);
    form.set('from', 'APPLIED');
    form.set('to', 'APPROVED');
    form.set('expectedVersion', '3');
    form.set('preflightToken', 'invoice-preflight-signed-token');
    form.set('intentId', intentId);
    form.set('reason', '资料核验通过');
    form.set('confirmed', 'true');
    await expect(action(form)).resolves.toMatchObject({ ok: true, status: 'APPROVED' });
    expect(executeInvoiceTransition).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        expectedStatus: 'APPLIED',
        expectedVersion: 3,
        transition: 'APPROVED',
      }),
    );
  });

  it('requires safe certificate and attachment metadata for ISSUED', async () => {
    const approvedInvoice = {
      ...invoicePayload.items[0],
      allowedTransitions: [
        {
          expiresAt: '2099-08-31T03:10:00.000Z',
          impact: '登记开票证书与交付附件元数据',
          preflightToken: 'invoice-issued-preflight-token',
          to: 'ISSUED',
        },
      ],
      status: 'APPROVED',
    };
    let receivedMutation:
      Parameters<FinanceOperationsPort['executeInvoiceTransition']>[0] | undefined;
    const executeInvoiceTransition = vi.fn(
      async (input: Parameters<FinanceOperationsPort['executeInvoiceTransition']>[0]) => {
        receivedMutation = input;
        return {
          auditRecordId,
          idempotencyKey: intentId,
          invoiceId,
          ok: true,
          requestId,
          status: 'ISSUED',
          version: 4,
        };
      },
    );
    const action = createInvoiceTransitionAction({
      context: {
        sessionToken: await session(['finance:invoice-issue']),
        signingKey,
      },
      port: {
        async getInvoice() {
          return approvedInvoice;
        },
        executeInvoiceTransition,
      } as unknown as FinanceOperationsPort,
    });
    const form = new FormData();
    form.set('invoiceId', invoiceId);
    form.set('from', 'APPROVED');
    form.set('to', 'ISSUED');
    form.set('expectedVersion', '3');
    form.set('preflightToken', 'invoice-issued-preflight-token');
    form.set('intentId', intentId);
    form.set('reason', '线下开票完成并登记交付材料');
    form.set('confirmed', 'true');
    form.set('certificateSerialMasked', '****98AF');
    form.set('certificateExpiresAt', '2027-08-31T00:00:00.000Z');
    form.set('attachmentFileId', fileId);
    form.set('attachmentName', '电子发票.pdf');
    form.set('attachmentMimeType', 'application/pdf');
    form.set('attachmentSizeBytes', '4096');
    form.set('attachmentUploadedAt', '2026-08-31T04:00:00.000Z');
    await expect(action(form)).resolves.toMatchObject({ status: 'ISSUED' });
    expect(receivedMutation?.issuanceMetadata?.certificate).toEqual({
      expiresAt: '2027-08-31T00:00:00.000Z',
      serialMasked: '****98AF',
    });
    form.set('certificateSerialMasked', 'PRIVATE KEY secret');
    await expect(action(form)).rejects.toThrow('发票签发元数据无效');
  });
});

describe('finance HTTP boundary', () => {
  it('uses trusted headers and the standard Idempotency-Key for repair mutations', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            auditRecordId,
            caseId,
            idempotencyKey: intentId,
            ok: true,
            requestId,
            version: 8,
          }),
          {
            headers: { 'Content-Type': 'application/json' },
            status: 200,
          },
        ),
    );
    const port = createHttpFinanceOperationsPort(
      {
        apiUrl: 'https://operations.internal',
        kmsIdentityReference: 'kms://admin-web/operations-client',
      },
      { fetchImpl },
    );
    await port.createCompensationRequest({
      actorId,
      audit: { idempotencyKey: intentId, reason: '修复渠道金额差异' },
      caseId,
      confirmed: true,
      expectedVersion: 7,
      preflightToken: 'recon-preflight-signed-token',
      requestContext: createOutboundRequestContext(
        () => '3123456789abcdef0123456789abcdef',
        () => intentId,
      ),
      requiredApprovals: 2,
      scope: 'ALL',
      trustedSessionToken: 'trusted-session-token',
    });
    const [, init] = fetchImpl.mock.calls[0] ?? [];
    const headers = new Headers(init?.headers);
    expect(headers.get('Idempotency-Key')).toBe(intentId);
    expect(headers.get('X-Admin-Session-Token')).toBe('trusted-session-token');
    expect(headers.get('X-Service-Identity-Kms-Ref')).toBe('kms://admin-web/operations-client');
  });

  it('records one context-bound safe telemetry event for a network failure', async () => {
    const events: unknown[] = [];
    const requestContext = createOutboundRequestContext(
      () => '4123456789abcdef0123456789abcdef',
      () => intentId,
    );
    const port = createHttpFinanceOperationsPort(
      {
        apiUrl: 'https://operations.internal',
        kmsIdentityReference: 'kms://admin-web/operations-client',
      },
      {
        fetchImpl: async () => Promise.reject(new Error('contains-sensitive-upstream-detail')),
        telemetry: {
          record(event) {
            events.push(event);
          },
        },
      },
    );
    await expect(
      port.listOrders({
        requestContext,
        scope: 'ALL',
        trustedSessionToken: 'trusted-session-token',
      }),
    ).rejects.toThrow();
    expect(events).toEqual([
      {
        correlationId: intentId,
        operation: 'operations.finance.orders-read',
        reason: 'NETWORK_FAILURE',
        traceId: '4123456789abcdef0123456789abcdef',
      },
    ]);
    expect(JSON.stringify(events)).not.toContain('contains-sensitive-upstream-detail');
  });
});
