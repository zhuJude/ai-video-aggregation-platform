import { beforeEach, describe, expect, it } from 'vitest';
import { AdjustmentService } from '../src/application/adjustment.service.js';
import { ReconciliationJob } from '../src/application/reconciliation.job.js';
import { WalletService } from '../src/application/wallet.service.js';
import { InMemoryLedgerRepository } from '../src/infrastructure/in-memory-ledger.repository.js';

const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';

describe('wallet reconciliation and dual approval', () => {
  let repository: InMemoryLedgerRepository;
  let wallet: WalletService;

  beforeEach(async () => {
    repository = new InMemoryLedgerRepository();
    wallet = new WalletService(repository);
    await wallet.credit({
      businessKey: 'payment:reconciliation:seed',
      userId,
      points: 100n,
      traceId: 'trace-reconciliation-seed',
    });
  });

  it('detects a balance snapshot that differs from immutable entries and blocks commands', async () => {
    repository.corruptSnapshot(userId, 'USER_AVAILABLE', 999n);
    const job = new ReconciliationJob(repository);

    const report = await job.run('trace-reconciliation');

    expect(report.mismatches).toContainEqual(
      expect.objectContaining({
        userId,
        account: 'USER_AVAILABLE',
        expected: 100n,
        actual: 999n,
      }),
    );
    expect(repository.outboxEvents()).toContainEqual(
      expect.objectContaining({ eventType: 'wallet.ledger-mismatch.v1', severity: 'P0' }),
    );
    await expect(
      wallet.reserve({
        businessKey: 'task:blocked:reserve',
        userId,
        points: 1n,
        traceId: 'trace-blocked',
      }),
    ).rejects.toMatchObject({ code: 'WALLET_BLOCKED' });
  });

  it('prevents the requester from approving their own adjustment', async () => {
    const adjustments = new AdjustmentService(repository, wallet, {
      canApprove: () => true,
    });
    const request = await adjustments.request({
      userId,
      direction: 'CREDIT',
      points: 100n,
      requestedBy: 'admin-a',
      reason: 'service compensation',
      traceId: 'trace-adjustment-request',
    });

    await expect(
      adjustments.approve(request.id, 'admin-a', 'trace-self-approval'),
    ).rejects.toMatchObject({
      code: 'DUAL_APPROVAL_REQUIRED',
    });
  });

  it('posts one compensating transaction after two distinct authorized approvals', async () => {
    const adjustments = new AdjustmentService(repository, wallet, {
      canApprove: (adminId) => adminId !== 'admin-denied',
    });
    const request = await adjustments.request({
      userId,
      direction: 'CREDIT',
      points: 25n,
      requestedBy: 'admin-requester',
      reason: 'verified ledger repair',
      traceId: 'trace-adjustment-request',
    });

    const first = await adjustments.approve(request.id, 'admin-a', 'trace-approval-a');
    expect(first.status).toBe('PENDING');
    await expect(wallet.getBalance(userId)).resolves.toMatchObject({ available: 100n });

    await expect(
      adjustments.approve(request.id, 'admin-denied', 'trace-approval-denied'),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_APPROVAL_FORBIDDEN' });

    const approved = await adjustments.approve(request.id, 'admin-b', 'trace-approval-b');
    const duplicate = await adjustments.approve(request.id, 'admin-b', 'trace-approval-b-repeat');

    expect(approved.status).toBe('POSTED');
    expect(duplicate.transactionId).toBe(approved.transactionId);
    await expect(wallet.getBalance(userId)).resolves.toMatchObject({ available: 125n });
    expect(
      (await wallet.listTransactions(userId)).filter(
        (transaction) => transaction.businessKey === `adjustment:${request.id}:apply`,
      ),
    ).toHaveLength(1);
  });
});
