import { describe, expect, it } from 'vitest';
import { PrismaPublicationRepository } from '../src/adapters/prisma-publication.repository.js';

describe('PrismaPublicationRepository transaction boundary', () => {
  it('rolls back a version transition when the outbox insert fails', async () => {
    const client = fakePrisma({ failOutbox: true });
    const repository = new PrismaPublicationRepository(client as never);
    await expect(repository.transact({ kind: 'all' }, (state) => {
      const row = state.packages.get('01990f24-2ba2-7000-8000-000000000010');
      if (row === undefined) throw new Error('missing seed');
      state.packages.set(row.id, { ...row, status: 'PUBLISHED', revision: 1, publishedAt: new Date('2026-08-31T12:00:00.000Z') });
      state.outbox.push({
        id: '01990f24-2ba2-7000-8000-000000000011', type: 'operations.package.published.v1', version: 1,
        occurredAt: '2026-08-31T12:00:00.000Z', traceId: '0123456789abcdef0123456789abcdef',
        correlationId: '01990f24-2ba2-7000-8000-000000000012', producer: 'operations-service', data: {},
        status: 'PENDING', attempts: 0, createdAt: new Date('2026-08-31T12:00:00.000Z'),
      });
    })).rejects.toThrow('OUTBOX_WRITE_FAILED');
    expect(client.rows.rechargePackageVersion?.[0]).toMatchObject({ status: 'DRAFT', revision: 0 });
    expect(client.rows.outboxEvent).toEqual([]);
  });

  it('turns a failed guarded update into VERSION_CONFLICT', async () => {
    const client = fakePrisma({ conflict: true });
    const repository = new PrismaPublicationRepository(client as never);
    await expect(repository.transact({ kind: 'all' }, (state) => {
      const row = state.packages.get('01990f24-2ba2-7000-8000-000000000010');
      if (row !== undefined) state.packages.set(row.id, { ...row, revision: 1, name: 'new' });
    })).rejects.toEqual(expect.objectContaining({ code: 'VERSION_CONFLICT' }));
  });

  it('uses a targeted public-package query without loading purchases or outbox history', async () => {
    const queried: string[] = [];
    const forbidden = (name: string) => ({ findMany: () => { queried.push(name); return Promise.reject(new Error(`unexpected ${name}`)); } });
    const client = {
      $transaction: <T>(work: (tx: Record<string, unknown>) => Promise<T>) => work({
        rechargePackageVersion: { findMany: () => { queried.push('packages'); return Promise.resolve([]); } },
        rechargePackagePurchaseSnapshot: forbidden('purchases'), contentEntry: forbidden('entries'), contentVersion: forbidden('content'),
        bannerPlacement: forbidden('placements'), bannerSlotRevision: forbidden('slots'), helpCategory: forbidden('categories'),
        publicSystemSettingVersion: forbidden('settings'), featureFlagVersion: forbidden('flags'), outboxEvent: forbidden('outbox'),
      }),
    };
    const repository = new PrismaPublicationRepository(client as never);
    await repository.snapshot({ kind: 'package', publicAt: new Date('2026-08-31T12:00:00Z') });
    expect(queried).toEqual(['packages']);
  });

  it('does not let direct repository writes bypass public-setting validation', async () => {
    const repository = new PrismaPublicationRepository(fakePrisma({}) as never);
    await expect(repository.transact({ kind: 'all' }, (state) => state.settings.set('01990f24-2ba2-7000-8000-000000000020', {
      id: '01990f24-2ba2-7000-8000-000000000020', settingKey: 'cdn.publicBaseUrl', version: 1, revision: 0, status: 'DRAFT',
      basePublishedVersionId: null, publicValue: { url: 'https://user:password@cdn.example.com' }, kmsSecretReferenceId: null,
      createdBy: '01990f24-2ba2-7000-8000-000000000002', createdAt: new Date('2026-08-31T12:00:00Z'), publishedAt: null, retiredAt: null,
    }))).rejects.toMatchObject({ code: 'INVALID_PUBLIC_CONFIGURATION' });
  });

  it('requires every direct banner mutation to advance its aggregate revision', async () => {
    const repository = new PrismaPublicationRepository(fakePrisma({}) as never);
    await expect(repository.transact({ kind: 'all' }, (state) => state.placements.set('01990f24-2ba2-7000-8000-000000000021', {
      id: '01990f24-2ba2-7000-8000-000000000021', contentVersionId: '01990f24-2ba2-7000-8000-000000000022', slot: 'HOME_HERO',
      sortOrder: 0, activeFrom: null, activeUntil: null, createdBy: '01990f24-2ba2-7000-8000-000000000002', createdAt: new Date('2026-08-31T12:00:00Z'),
    }))).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
});

function fakePrisma(options: { failOutbox?: boolean; conflict?: boolean }) {
  const rows: Record<string, Array<Record<string, unknown>>> = {
    rechargePackageVersion: [{
      id: '01990f24-2ba2-7000-8000-000000000010', packageId: '01990f24-2ba2-7000-8000-000000000010',
      version: 1, revision: 0, status: 'DRAFT', name: 'old', amountMinor: 100n, currency: 'CNY', points: 1n,
      bonusPoints: 0n, purchaseLimit: null, validityDays: null, sortOrder: 0, activeFrom: null, activeUntil: null,
      createdBy: '01990f24-2ba2-7000-8000-000000000002', createdAt: new Date('2026-08-31T11:00:00.000Z'),
      publishedAt: null, retiredAt: null,
    }],
    rechargePackagePurchaseSnapshot: [], contentEntry: [], contentVersion: [], bannerPlacement: [], bannerSlotRevision: [],
    helpCategory: [], publicSystemSettingVersion: [], featureFlagVersion: [], outboxEvent: [],
  };
  return {
    rows,
    async $transaction<T>(work: (tx: Record<string, unknown>) => Promise<T>): Promise<T> {
      const draft = structuredClone(rows);
      const tx = Object.fromEntries(Object.keys(draft).map((name) => [name, delegate(draft[name] ?? [], name, options)]));
      const result = await work(tx);
      for (const key of Object.keys(rows)) rows[key] = draft[key] ?? [];
      return result;
    },
  };
}

function delegate(rows: Array<Record<string, unknown>>, name: string, options: { failOutbox?: boolean; conflict?: boolean }) {
  return {
    findMany: () => Promise.resolve(structuredClone(rows)),
    create: ({ data }: { data: Record<string, unknown> }) => {
      if (name === 'outboxEvent' && options.failOutbox) return Promise.reject(new Error('OUTBOX_WRITE_FAILED'));
      rows.push(structuredClone(data)); return Promise.resolve(data);
    },
    updateMany: ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      if (name === 'rechargePackageVersion' && options.conflict) return Promise.resolve({ count: 0 });
      const index = rows.findIndex((row) => row.id === where.id && (where.revision === undefined || row.revision === where.revision));
      if (index < 0) return Promise.resolve({ count: 0 });
      rows[index] = { ...rows[index], ...structuredClone(data) };
      return Promise.resolve({ count: 1 });
    },
  };
}
