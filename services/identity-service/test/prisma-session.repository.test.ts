import { describe, expect, it, vi } from 'vitest';

import { PrismaSessionRepository } from '../src/adapters/prisma-session.repository.js';
import type { RotateSessionInput, SessionRecord } from '../src/application/session.service.js';

const now = new Date('2026-09-01T00:00:00.000Z');
const current: SessionRecord & { user: { status: string } } = {
  id: '0198fabc-1234-7abc-8abc-111111111111',
  userId: '0198fabc-1234-7abc-8abc-222222222222',
  familyId: '0198fabc-1234-7abc-8abc-333333333333',
  refreshTokenDigest: 'a'.repeat(64),
  deviceName: 'Chrome',
  expiresAt: new Date('2026-10-01T00:00:00.000Z'),
  consumedAt: null,
  revokedAt: null,
  createdAt: now,
  user: { status: 'ACTIVE' },
};
const rotation: RotateSessionInput = {
  presentedDigest: current.refreshTokenDigest,
  now,
  successor: {
    id: '0198fabc-1234-7abc-8abc-444444444444',
    refreshTokenDigest: 'b'.repeat(64),
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    createdAt: now,
  },
};

function repositoryWith(transaction: object, rootOverrides: object = {}) {
  const transactionWithLock = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    ...transaction,
  };
  const prisma = {
    $transaction: (work: (client: object) => Promise<unknown>) => work(transactionWithLock),
    session: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn().mockResolvedValue({ familyId: current.familyId }),
      findMany: vi.fn().mockResolvedValue([current]),
      count: vi.fn().mockResolvedValue(1),
    },
    ...rootOverrides,
  };
  return { prisma, repository: new PrismaSessionRepository(prisma as never) };
}

describe('PrismaSessionRepository', () => {
  it('locks account then family and re-reads the presented refresh row under READ COMMITTED', async () => {
    const order: string[] = [];
    let transactionOptions: unknown;
    const transaction = {
      $queryRaw: (query: { values: unknown[] }) => {
        order.push(`lock:${String(query.values[0])}`);
        return Promise.resolve([]);
      },
      session: {
        findUnique: vi
          .fn()
          .mockImplementationOnce(() => {
            order.push('locate');
            return Promise.resolve({
              id: current.id,
              userId: current.userId,
              familyId: current.familyId,
            });
          })
          .mockImplementationOnce(() => {
            order.push('reread');
            return Promise.resolve(current);
          }),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create: vi.fn().mockResolvedValue({
          ...current,
          ...rotation.successor,
          consumedAt: null,
          revokedAt: null,
        }),
      },
    };
    const prisma = {
      $transaction: (work: (client: object) => Promise<unknown>, options: unknown) => {
        transactionOptions = options;
        return work(transaction);
      },
    };
    const repository = new PrismaSessionRepository(prisma as never);

    await expect(repository.rotate(rotation)).resolves.toMatchObject({ kind: 'rotated' });
    expect(order).toEqual([
      'locate',
      `lock:identity-account:${current.userId}`,
      `lock:identity-session-family:${current.familyId}`,
      'reread',
    ]);
    expect(transactionOptions).toMatchObject({
      isolationLevel: 'ReadCommitted',
      maxWait: 5_000,
      timeout: 10_000,
    });
  });

  it('locks account and family before create re-checks ACTIVE state', async () => {
    const order: string[] = [];
    const transaction = {
      $queryRaw: (query: { values: unknown[] }) => {
        order.push(`lock:${String(query.values[0])}`);
        return Promise.resolve([]);
      },
      user: {
        findUnique: () => {
          order.push('user');
          return Promise.resolve({ status: 'ACTIVE' });
        },
      },
      session: {
        create: () => {
          order.push('create');
          return Promise.resolve(current);
        },
      },
    };
    const { repository } = repositoryWith(transaction);

    await repository.create(current);

    expect(order).toEqual([
      `lock:identity-account:${current.userId}`,
      `lock:identity-session-family:${current.familyId}`,
      'user',
      'create',
    ]);
  });

  it('creates a session atomically only for an ACTIVE user', async () => {
    const create = vi.fn().mockResolvedValue(current);
    const findUnique = vi.fn().mockResolvedValue({ status: 'ACTIVE' });
    const { repository } = repositoryWith({
      user: { findUnique },
      session: { create },
    });
    await expect(repository.create(current)).resolves.toMatchObject({ id: current.id });
    expect(create).toHaveBeenCalledOnce();

    findUnique.mockResolvedValueOnce({ status: 'CLOSED' });
    await expect(repository.create(current)).rejects.toMatchObject({ code: 'USER_INACTIVE' });
  });

  it.each([
    ['missing', null, 'invalid'],
    ['consumed', { ...current, consumedAt: now }, 'reuse'],
    ['revoked', { ...current, revokedAt: now }, 'revoked'],
    ['expired', { ...current, expiresAt: now }, 'expired'],
    ['inactive user', { ...current, user: { status: 'CLOSED' } }, 'user_inactive'],
  ])('maps a %s refresh row to %s', async (_case, row, expected) => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const findUnique = vi.fn();
    if (row === null) {
      findUnique.mockResolvedValueOnce(null);
    } else {
      findUnique
        .mockResolvedValueOnce({
          id: current.id,
          userId: current.userId,
          familyId: current.familyId,
        })
        .mockResolvedValueOnce(row);
    }
    const { repository } = repositoryWith({
      session: {
        findUnique,
        updateMany,
        create: vi.fn(),
      },
    });
    await expect(repository.rotate(rotation)).resolves.toMatchObject({ kind: expected });
    if (expected === 'reuse') expect(updateMany).toHaveBeenCalledOnce();
  });

  it('atomically consumes and creates a successor', async () => {
    const successor = { ...current, ...rotation.successor, consumedAt: null, revokedAt: null };
    const create = vi.fn().mockResolvedValue(successor);
    const { repository } = repositoryWith({
      session: {
        findUnique: vi
          .fn()
          .mockResolvedValueOnce({
            id: current.id,
            userId: current.userId,
            familyId: current.familyId,
          })
          .mockResolvedValueOnce(current),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        create,
      },
    });
    await expect(repository.rotate(rotation)).resolves.toMatchObject({
      kind: 'rotated',
      session: { id: rotation.successor.id, familyId: current.familyId },
    });
    expect(create).toHaveBeenCalledOnce();
  });

  it.each([
    [{ ...current, consumedAt: now }, 'reuse'],
    [{ ...current, revokedAt: now }, 'revoked'],
    [{ ...current, expiresAt: now }, 'expired'],
  ])('resolves a failed compare-and-swap race as %s', async (raced, expected) => {
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: current.id,
        userId: current.userId,
        familyId: current.familyId,
      })
      .mockResolvedValueOnce(current)
      .mockResolvedValueOnce(raced);
    const { repository } = repositoryWith({
      session: {
        findUnique,
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        create: vi.fn(),
      },
    });
    await expect(repository.rotate(rotation)).resolves.toMatchObject({ kind: expected });
  });

  it('supports safe listing and access status checks', async () => {
    const rootSession = {
      findMany: vi.fn().mockResolvedValue([current]),
      count: vi.fn().mockResolvedValue(1),
    };
    const { repository } = repositoryWith({}, { session: rootSession });

    await expect(repository.listActive(current.userId, now)).resolves.toEqual([
      expect.objectContaining({ id: current.id }),
    ]);
    await expect(repository.isActive(current.userId, current.id, now)).resolves.toBe(true);
    expect(rootSession.count).toHaveBeenCalledWith({
      where: {
        id: current.id,
        userId: current.userId,
        consumedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
        user: { status: 'ACTIVE' },
      },
    });
  });

  it('revokeById re-reads after locks and revokes the whole device family', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 2 });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({
        id: current.id,
        userId: current.userId,
        familyId: current.familyId,
      })
      .mockResolvedValueOnce(current);
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      session: { findUnique, updateMany },
    };
    const { repository } = repositoryWith(transaction);

    await expect(repository.revokeById(current.userId, current.id, now)).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { familyId: current.familyId, userId: current.userId, revokedAt: null },
      data: { revokedAt: now },
    });
  });

  it('revokeFamilyByDigest locks and re-reads before revoking every family row', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const findUnique = vi
      .fn()
      .mockResolvedValueOnce({ userId: current.userId, familyId: current.familyId })
      .mockResolvedValueOnce({ userId: current.userId, familyId: current.familyId });
    const transaction = {
      $queryRaw: vi.fn().mockResolvedValue([]),
      session: { findUnique, updateMany },
    };
    const { repository } = repositoryWith(transaction);

    await repository.revokeFamilyByDigest(current.refreshTokenDigest, now);

    expect(findUnique).toHaveBeenCalledTimes(2);
    expect(updateMany).toHaveBeenCalledWith({
      where: { familyId: current.familyId, revokedAt: null },
      data: { revokedAt: now },
    });
  });
});
