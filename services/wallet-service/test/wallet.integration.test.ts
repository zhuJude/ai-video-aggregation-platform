import { beforeEach, describe, expect, it } from 'vitest';
import { WalletService } from '../src/application/wallet.service.js';
import { InMemoryLedgerRepository } from '../src/infrastructure/in-memory-ledger.repository.js';

const userId = '0198f5f6-b5c9-7d33-a4a5-608b27b9d776';

describe('WalletService concurrent commands', () => {
  let repository: InMemoryLedgerRepository;
  let service: WalletService;

  beforeEach(async () => {
    repository = new InMemoryLedgerRepository();
    service = new WalletService(repository);
    await service.credit({
      businessKey: 'payment:seed:credit',
      userId,
      points: 100n,
      traceId: 'trace-seed',
    });
  });

  it('allows only one of two reservations that exceed the balance together', async () => {
    const results = await Promise.allSettled([
      service.reserve({
        businessKey: 'task:a:reserve',
        userId,
        points: 80n,
        traceId: 'trace-a',
      }),
      service.reserve({
        businessKey: 'task:b:reserve',
        userId,
        points: 80n,
        traceId: 'trace-b',
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    await expect(service.getBalance(userId)).resolves.toEqual({
      userId,
      available: 20n,
      frozen: 80n,
    });
  });

  it('returns the original result for a repeated business key', async () => {
    const command = {
      businessKey: 'task:idem:reserve',
      userId,
      points: 40n,
      traceId: 'trace-idempotent',
    };

    const first = await service.reserve(command);
    const second = await service.reserve(command);

    expect(second.transactionId).toBe(first.transactionId);
    await expect(service.getBalance(userId)).resolves.toMatchObject({
      available: 60n,
      frozen: 40n,
    });
  });

  it('rejects reuse of a business key with a different command', async () => {
    await service.reserve({
      businessKey: 'task:conflict:reserve',
      userId,
      points: 20n,
      traceId: 'trace-conflict-a',
    });

    await expect(
      service.reserve({
        businessKey: 'task:conflict:reserve',
        userId,
        points: 21n,
        traceId: 'trace-conflict-b',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('settles consumed points and releases the unused frozen difference', async () => {
    await service.reserve({
      businessKey: 'task:settlement:reserve',
      userId,
      points: 80n,
      traceId: 'trace-reserve',
    });

    await service.settle({
      businessKey: 'task:settlement:settle',
      userId,
      points: 60n,
      traceId: 'trace-settle',
    });
    await service.release({
      businessKey: 'task:settlement:release',
      userId,
      points: 20n,
      traceId: 'trace-release',
    });

    await expect(service.getBalance(userId)).resolves.toEqual({
      userId,
      available: 40n,
      frozen: 0n,
    });
  });

  it('never permits available or frozen balances to become negative', async () => {
    await expect(
      service.reserve({
        businessKey: 'task:too-large:reserve',
        userId,
        points: 101n,
        traceId: 'trace-too-large',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_AVAILABLE_POINTS' });

    await expect(
      service.release({
        businessKey: 'task:not-frozen:release',
        userId,
        points: 1n,
        traceId: 'trace-not-frozen',
      }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_FROZEN_POINTS' });
  });

  it('posts an idempotent refund compensation that reverses credited points', async () => {
    const command = {
      businessKey: 'refund:order-1:wallet',
      userId,
      points: 30n,
      traceId: 'trace-refund',
    };

    const first = await service.refund(command);
    const repeated = await service.refund(command);

    expect(first.kind).toBe('REFUND');
    expect(repeated.transactionId).toBe(first.transactionId);
    await expect(service.getBalance(userId)).resolves.toEqual({
      userId,
      available: 70n,
      frozen: 0n,
    });
  });
});
