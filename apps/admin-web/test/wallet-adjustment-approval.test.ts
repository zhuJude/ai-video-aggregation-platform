/* eslint-disable @typescript-eslint/require-await -- async fakes model protected ports. */

import { describe, expect, it } from 'vitest';

import {
  createWalletAdjustmentApprovalAction,
  createWalletAdjustmentApprovalPreviewAction,
  type WalletAdjustmentRequestPort,
} from '../lib/user-operation-actions';
import { signAdminSession } from '../lib/session-auth';

const key = 'wallet-approval-signing-key-at-least-32-bytes';
const userId = '0198f7a4-c6d1-7b39-8a4e-73af0c1d2e3f';
const requesterId = '0198f7a4-c6d2-7b39-8a4e-73af0c1d2e3f';
const approverId = '0198f7a4-c6d3-7b39-8a4e-73af0c1d2e3f';
const requestId = '0198f7a4-c6d5-7b39-8a4e-73af0c1d2e3f';
const auditId = '0198f7a4-c6d4-7b39-8a4e-73af0c1d2e3f';
const intentId = '0198f7a4-c6d6-7b39-8a4e-73af0c1d2e3f';

async function token(subjectId = approverId) {
  return signAdminSession(
    {
      dataScope: 'ALL',
      expiresAt: Date.now() + 60_000,
      permissions: ['users:read', 'finance:read', 'wallet:adjust'],
      sessionInstanceId: '0198f7a4-c6da-7b39-8a4e-73af0c1d2e3f',
      subjectId,
    },
    key,
  );
}

function request() {
  return {
    approverId,
    direction: 'CREDIT' as const,
    id: requestId,
    points: '10',
    requestedById: requesterId,
    status: 'PENDING_APPROVAL' as const,
    userId,
    version: 1,
  };
}

function form() {
  const value = new FormData();
  value.set('userId', userId);
  value.set('requestId', requestId);
  value.set('expectedVersion', '1');
  value.set('reason', '独立复核通过');
  value.set('previewIntentId', intentId);
  return value;
}

describe('wallet adjustment second-admin approval', () => {
  it('re-fetches authority for preview and approval and returns a strict audited receipt', async () => {
    let reads = 0;
    let previews = 0;
    let approvals = 0;
    const port: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        return [];
      },
      async getAdjustmentRequest() {
        reads += 1;
        return request();
      },
      async previewApproval() {
        previews += 1;
        return {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: '余额 100 → 110',
          preflightToken: 'approval-token-abcdefghijklmnopqrstuvwxyz',
          resultStatus: 'APPROVED',
          resultVersion: 2,
        };
      },
      async approveAdjustment() {
        approvals += 1;
        return { auditRecordId: auditId, requestId, status: 'APPROVED', userId, version: 2 };
      },
      async submitAdjustmentRequest() {
        throw new Error('not used');
      },
    };
    const dependencies = {
      adjustmentPort: port,
      guardContext: { sessionToken: await token(), signingKey: key },
      scopePort: {
        async getUserScope() {
          return { assignedAdminIds: [], ownerAdminId: null };
        },
      },
    };
    const input = form();
    const preview = await createWalletAdjustmentApprovalPreviewAction(dependencies)(input);
    input.set('preflightToken', preview.preflightToken);
    input.set('previewExpiresAt', preview.expiresAt);
    input.set('intentId', intentId);
    input.set('highRiskConfirmed', 'true');
    await expect(createWalletAdjustmentApprovalAction(dependencies)(input)).resolves.toEqual({
      auditRecordId: auditId,
      ok: true,
      requestId,
      status: 'APPROVED',
      userId,
      version: 2,
    });
    expect({ approvals, previews, reads }).toEqual({ approvals: 1, previews: 2, reads: 2 });
  });

  it.each([
    ['requester self approval', requesterId, request(), '禁止申请人自审'],
    ['wrong assigned approver', '0198f7a4-c6d7-7b39-8a4e-73af0c1d2e3f', request(), '非指定复核人'],
    ['stale request', approverId, { ...request(), version: 2 }, '审批版本已变化'],
    [
      'terminal request',
      approverId,
      { ...request(), status: 'APPROVED' as const },
      '申请已不再待审批',
    ],
  ])(
    'fails closed for %s before an approval mutation',
    async (_name, actor, authoritative, message) => {
      let approvals = 0;
      const port: WalletAdjustmentRequestPort = {
        async getEligibleApprovers() {
          return [];
        },
        async getAdjustmentRequest() {
          return authoritative;
        },
        async previewApproval() {
          throw new Error('not used');
        },
        async approveAdjustment() {
          approvals += 1;
          throw new Error('must not mutate');
        },
        async submitAdjustmentRequest() {
          throw new Error('not used');
        },
      };
      const input = form();
      input.set('preflightToken', 'approval-token-abcdefghijklmnopqrstuvwxyz');
      input.set('previewExpiresAt', new Date(Date.now() + 60_000).toISOString());
      input.set('intentId', intentId);
      input.set('highRiskConfirmed', 'true');
      const action = createWalletAdjustmentApprovalAction({
        adjustmentPort: port,
        guardContext: { sessionToken: await token(actor), signingKey: key },
        scopePort: {
          async getUserScope() {
            return { assignedAdminIds: [], ownerAdminId: null };
          },
        },
      });
      await expect(action(input)).rejects.toThrow(message);
      expect(approvals).toBe(0);
    },
  );

  it('rejects a stale client token even when its client expiry is forged into the future', async () => {
    let approvals = 0;
    const port: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        return [];
      },
      async getAdjustmentRequest() {
        return request();
      },
      async previewApproval() {
        return {
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          impact: '余额 100 → 110',
          preflightToken: 'fresh-approval-token-abcdefghijklmnop',
          resultStatus: 'APPROVED',
          resultVersion: 2,
        };
      },
      async approveAdjustment() {
        approvals += 1;
        throw new Error('must not mutate');
      },
      async submitAdjustmentRequest() {
        throw new Error('not used');
      },
    };
    const input = form();
    input.set('preflightToken', 'stale-approval-token-abcdefghijklmnop');
    input.set('previewExpiresAt', new Date(Date.now() + 60_000).toISOString());
    input.set('intentId', intentId);
    input.set('highRiskConfirmed', 'true');
    await expect(
      createWalletAdjustmentApprovalAction({
        adjustmentPort: port,
        guardContext: { sessionToken: await token(), signingKey: key },
        scopePort: {
          async getUserScope() {
            return { assignedAdminIds: [], ownerAdminId: null };
          },
        },
      })(input),
    ).rejects.toThrow('审批预检已变化');
    expect(approvals).toBe(0);
  });

  it('rejects an expired authoritative server re-preview before mutation', async () => {
    let approvals = 0;
    const port: WalletAdjustmentRequestPort = {
      async getEligibleApprovers() {
        return [];
      },
      async getAdjustmentRequest() {
        return request();
      },
      async previewApproval() {
        return {
          expiresAt: new Date(Date.now() - 1_000).toISOString(),
          impact: '余额 100 → 110',
          preflightToken: 'approval-token-abcdefghijklmnopqrstuvwxyz',
          resultStatus: 'APPROVED',
          resultVersion: 2,
        };
      },
      async approveAdjustment() {
        approvals += 1;
        return { auditRecordId: auditId, requestId, status: 'APPROVED', userId, version: 2 };
      },
      async submitAdjustmentRequest() {
        throw new Error('not used');
      },
    };
    const input = form();
    input.set('preflightToken', 'approval-token-abcdefghijklmnopqrstuvwxyz');
    input.set('previewExpiresAt', new Date(Date.now() + 60_000).toISOString());
    input.set('intentId', intentId);
    input.set('highRiskConfirmed', 'true');
    await expect(
      createWalletAdjustmentApprovalAction({
        adjustmentPort: port,
        guardContext: { sessionToken: await token(), signingKey: key },
        scopePort: {
          async getUserScope() {
            return { assignedAdminIds: [], ownerAdminId: null };
          },
        },
      })(input),
    ).rejects.toThrow('审批预检响应无效');
    expect(approvals).toBe(0);
  });
});
