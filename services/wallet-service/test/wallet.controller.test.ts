import type { ExecutionContext } from '@nestjs/common';
import { beforeEach, describe, expect, it } from 'vitest';
import { WalletService } from '../src/application/wallet.service.js';
import { InternalAuthGuard } from '../src/http/internal-auth.guard.js';
import { InternalWalletController, UserWalletController } from '../src/http/wallet.controller.js';
import { InMemoryLedgerRepository } from '../src/infrastructure/in-memory-ledger.repository.js';

const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';

function executionContext(headers: Record<string, string>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('wallet HTTP boundary', () => {
  let internalController: InternalWalletController;
  let userController: UserWalletController;

  beforeEach(() => {
    const wallet = new WalletService(new InMemoryLedgerRepository());
    internalController = new InternalWalletController(wallet);
    userController = new UserWalletController(wallet);
  });

  it('accepts points only as an unsigned decimal string', async () => {
    await expect(
      internalController.credit({
        businessKey: 'payment:http:credit',
        userId,
        points: '100',
        traceId: '0123456789abcdef0123456789abcdef',
      }),
    ).resolves.toMatchObject({ points: '100' });

    await expect(
      internalController.reserve({
        businessKey: 'task:http:reserve',
        userId,
        points: 1 as unknown as string,
        traceId: '0123456789abcdef0123456789abcdef',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_POINTS' });
  });

  it('serializes wallet balances and transactions without JSON bigint values', async () => {
    await internalController.credit({
      businessKey: 'payment:http:list',
      userId,
      points: '25',
      traceId: '0123456789abcdef0123456789abcdef',
    });

    const balance = await userController.balance(userId);
    const transactions = await userController.transactions(userId);

    expect(balance).toEqual({ userId, available: '25', frozen: '0' });
    expect(transactions[0]).toMatchObject({ points: '25' });
    expect(() => JSON.stringify({ balance, transactions })).not.toThrow();
  });

  it('authenticates internal service name and bearer secret', () => {
    const guard = new InternalAuthGuard({
      bearerSecret: 'kms-resolved-test-secret',
      allowedServices: new Set(['payment-service', 'generation-service']),
    });

    expect(
      guard.canActivate(
        executionContext({
          'x-internal-service': 'payment-service',
          authorization: 'Bearer kms-resolved-test-secret',
        }),
      ),
    ).toBe(true);
    expect(() =>
      guard.canActivate(
        executionContext({
          'x-internal-service': 'unknown-service',
          authorization: 'Bearer kms-resolved-test-secret',
        }),
      ),
    ).toThrow(expect.objectContaining({ status: 401 }));
  });
});
