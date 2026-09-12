import 'server-only';

import { UuidSchema } from '@repo/contracts/common';

import { createUuidV7, isUuidV7 } from '../tasks/identifiers';
import { commerceOwnerIdFromPhone } from './identity';
import { createMockAssetAccess } from './mock-upload-boundary';
import { requireMockCommerce } from './mock-config';
import {
  completeMockUpload,
  deleteMockObject,
  ensureMockSeedObjects,
  findMockObject,
  listMockObjects,
  MockObjectStoreError,
  renameMockObject,
} from './mock-object-store';
import type {
  AssetFilters,
  CommerceGateway,
  InvoiceHistoryItem,
  LedgerTransaction,
  RechargeOrderView,
} from './types';

export class CommerceCommandError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;
}

const FIXTURE_PHONE = '+8613800138000';
const ASSET_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7101';
const IMAGE_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7102';
const PAID_ORDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7201';
const PENDING_ORDER_ID = '0198f4d4-21c2-7b7d-8a03-08a0da2a7202';

type Owned<T> = T & { readonly ownerId: string };

function fixtureOwnerId(): string {
  return commerceOwnerIdFromPhone(FIXTURE_PHONE);
}

const fixtureAssets = [
  {
    assetId: ASSET_ID,
    kind: 'RESULT',
    name: '海边公路.mp4',
    mimeType: 'video/mp4',
    createdAt: '2026-08-31T10:00:00.000Z',
    bytes: new Uint8Array([
      0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 0, 0,
    ]),
  },
  {
    assetId: IMAGE_ID,
    kind: 'UPLOAD',
    name: '山谷起始帧.webp',
    mimeType: 'image/webp',
    createdAt: '2026-08-30T08:30:00.000Z',
    bytes: new TextEncoder().encode('RIFF0000WEBP'),
  },
] as const;

const ledger: readonly Owned<LedgerTransaction>[] = [
  {
    get ownerId() {
      return fixtureOwnerId();
    },
    id: 'ledger-recharge-1',
    type: 'CREDIT',
    direction: 'CREDIT',
    status: 'POSTED',
    points: '9007199254742193',
    occurredAt: '2026-08-31T09:00:00.000Z',
    reference: { kind: 'ORDER', id: PAID_ORDER_ID, label: '充值订单' },
  },
  {
    get ownerId() {
      return fixtureOwnerId();
    },
    id: 'ledger-reserve-1',
    type: 'RESERVE',
    direction: 'TRANSFER',
    status: 'POSTED',
    points: '1200',
    occurredAt: '2026-08-31T10:00:00.000Z',
    reference: { kind: 'TASK', id: 'task-1', label: '生成任务 T20260831-0001' },
  },
  {
    get ownerId() {
      return fixtureOwnerId();
    },
    id: 'ledger-settle-1',
    type: 'SETTLE',
    direction: 'DEBIT',
    status: 'POSTED',
    points: '800',
    occurredAt: '2026-08-31T11:00:00.000Z',
    reference: { kind: 'TASK', id: 'task-2', label: '生成任务 T20260831-0002' },
  },
];

const orders: Owned<RechargeOrderView>[] = [
  {
    get ownerId() {
      return fixtureOwnerId();
    },
    id: PAID_ORDER_ID,
    amountMinor: '10001',
    currency: 'CNY',
    points: '9007199254740993',
    status: 'PAID',
    createdAt: '2026-08-31T09:00:00.000Z',
    paidAt: '2026-08-31T09:01:00.000Z',
  },
  {
    get ownerId() {
      return fixtureOwnerId();
    },
    id: PENDING_ORDER_ID,
    amountMinor: '9900',
    currency: 'CNY',
    points: '10000',
    status: 'PENDING',
    createdAt: '2026-09-12T10:00:00.000Z',
    expiresAt: '2026-09-12T10:15:00.000Z',
  },
];

const invoices: Owned<InvoiceHistoryItem>[] = [];
const invoicedOrders = new Set<string>();
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1_000;
const IDEMPOTENCY_MAX_ENTRIES = 10_000;
const idempotency = new Map<
  string,
  {
    readonly ownerId: string;
    readonly fingerprint: string;
    readonly value: unknown;
    readonly expiresAt: number;
  }
>();

function assertOwner(ownerId: string): void {
  requireMockCommerce();
  if (!UuidSchema.safeParse(ownerId).success)
    throw new CommerceCommandError('AUTHENTICATION_REQUIRED');
}

function publicValue<T extends { readonly ownerId: string }>(value: T): Omit<T, 'ownerId'> {
  const { ownerId, ...result } = value;
  void ownerId;
  return result;
}

async function ensureFixtureAssets(ownerId: string): Promise<void> {
  if (ownerId === fixtureOwnerId()) await ensureMockSeedObjects(ownerId, fixtureAssets);
}

function translateStoreError(error: unknown): never {
  if (error instanceof MockObjectStoreError && error.code === 'IDEMPOTENCY_CONFLICT') {
    throw new CommerceCommandError('IDEMPOTENCY_CONFLICT');
  }
  throw error;
}

function command<T>(key: string, ownerId: string, fingerprint: string, create: () => T): T {
  if (!isUuidV7(key)) throw new CommerceCommandError('INVALID_IDEMPOTENCY_KEY');
  const now = Date.now();
  for (const [candidateKey, entry] of idempotency) {
    if (entry.expiresAt <= now) idempotency.delete(candidateKey);
  }
  const existing = idempotency.get(key);
  if (existing) {
    if (existing.ownerId !== ownerId || existing.fingerprint !== fingerprint)
      throw new CommerceCommandError('IDEMPOTENCY_CONFLICT');
    return structuredClone(existing.value) as T;
  }
  if (idempotency.size >= IDEMPOTENCY_MAX_ENTRIES)
    throw new CommerceCommandError('IDEMPOTENCY_CAPACITY_EXCEEDED');
  const value = create();
  idempotency.set(key, {
    ownerId,
    fingerprint,
    value: structuredClone(value),
    expiresAt: now + IDEMPOTENCY_TTL_MS,
  });
  return value;
}

function listOffset(cursor: string | undefined): number {
  if (cursor === undefined || cursor === 'page-1') return 0;
  if (cursor === 'page-2') return 2;
  throw new CommerceCommandError('INVALID_CURSOR');
}

export const commerceGateway: CommerceGateway = {
  async listAssets(filters: AssetFilters, context): Promise<unknown> {
    assertOwner(context.ownerId);
    await ensureFixtureAssets(context.ownerId);
    const stored = (await listMockObjects(context.ownerId)).map((item) => ({
      ownerId: item.ownerId,
      id: item.assetId,
      kind: item.kind,
      name: item.name,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      createdAt: item.createdAt,
      posterAlt: `${item.name} 素材预览`,
    }));
    const matches = stored.filter((asset) => {
      if (asset.ownerId !== context.ownerId) return false;
      if (filters.kind && asset.kind !== filters.kind) return false;
      if (filters.mediaType && !asset.mimeType.startsWith(filters.mediaType.toLowerCase()))
        return false;
      if (
        filters.query &&
        !asset.name.toLocaleLowerCase('zh-CN').includes(filters.query.toLocaleLowerCase('zh-CN'))
      )
        return false;
      return true;
    });
    const offset = listOffset(filters.cursor);
    return Promise.resolve({
      items: matches.slice(offset, offset + 2).map(publicValue),
      pageInfo: {
        ...(offset > 0 ? { previousCursor: 'page-1' } : {}),
        ...(offset + 2 < matches.length ? { nextCursor: 'page-2' } : {}),
      },
    });
  },

  async requestAssetAccess(assetId, purpose, context): Promise<unknown> {
    assertOwner(context.ownerId);
    await ensureFixtureAssets(context.ownerId);
    const stored = await findMockObject(assetId, context.ownerId);
    if (stored) {
      return createMockAssetAccess({
        assetId: stored.assetId,
        ownerId: stored.ownerId,
        storageKey: stored.storageKey,
        purpose,
      });
    }
    throw new CommerceCommandError('ASSET_NOT_FOUND');
  },

  async completeUpload(receipt, context): Promise<unknown> {
    assertOwner(context.ownerId);
    if (
      receipt.ownerId !== context.ownerId ||
      receipt.assetId !== context.idempotencyKey ||
      receipt.idempotencyKey !== context.idempotencyKey
    )
      throw new CommerceCommandError('UPLOAD_RECEIPT_MISMATCH');
    return completeMockUpload(receipt);
  },

  async renameAsset(assetId, name, context): Promise<unknown> {
    assertOwner(context.ownerId);
    const normalized = name.trim();
    if (normalized.length < 1 || normalized.length > 120)
      throw new CommerceCommandError('INVALID_ASSET_NAME');
    if (!isUuidV7(context.idempotencyKey))
      throw new CommerceCommandError('INVALID_IDEMPOTENCY_KEY');
    await ensureFixtureAssets(context.ownerId);
    try {
      const renamed = await renameMockObject(
        assetId,
        context.ownerId,
        normalized,
        context.idempotencyKey,
      );
      if (!renamed) throw new CommerceCommandError('ASSET_NOT_FOUND');
      return renamed;
    } catch (error) {
      translateStoreError(error);
    }
  },

  async deleteAsset(assetId, context): Promise<unknown> {
    assertOwner(context.ownerId);
    if (!isUuidV7(context.idempotencyKey))
      throw new CommerceCommandError('INVALID_IDEMPOTENCY_KEY');
    await ensureFixtureAssets(context.ownerId);
    try {
      const deleted = await deleteMockObject(assetId, context.ownerId, context.idempotencyKey);
      if (!deleted) throw new CommerceCommandError('ASSET_NOT_FOUND');
      return { accepted: true };
    } catch (error) {
      translateStoreError(error);
    }
  },

  async getWallet(filters, context): Promise<unknown> {
    assertOwner(context.ownerId);
    const all = ledger.filter(
      (transaction) =>
        transaction.ownerId === context.ownerId &&
        (!filters.type || transaction.type === filters.type),
    );
    const offset = listOffset(filters.cursor);
    return Promise.resolve({
      balance: {
        available: context.ownerId === fixtureOwnerId() ? '9007199254740993' : '0',
        frozen: context.ownerId === fixtureOwnerId() ? '1200' : '0',
        totalRecharged: context.ownerId === fixtureOwnerId() ? '9007199254742193' : '0',
        totalConsumed: context.ownerId === fixtureOwnerId() ? '800' : '0',
      },
      transactions: all.slice(offset, offset + 2).map(publicValue),
      pageInfo: {
        ...(offset > 0 ? { previousCursor: 'page-1' } : {}),
        ...(offset + 2 < all.length ? { nextCursor: 'page-2' } : {}),
      },
    });
  },

  async listOrders(filters, context): Promise<unknown> {
    assertOwner(context.ownerId);
    const all = orders.filter(
      (order) =>
        order.ownerId === context.ownerId && (!filters.status || order.status === filters.status),
    );
    const offset = listOffset(filters.cursor);
    return Promise.resolve({
      packages: [
        { id: 'starter', amountMinor: '9900', currency: 'CNY', points: '10000' },
        { id: 'creator', amountMinor: '29900', currency: 'CNY', points: '32000' },
        { id: 'studio', amountMinor: '89900', currency: 'CNY', points: '100000' },
      ],
      customAmount: { minMinor: '100', maxMinor: '500000', stepMinor: '100' },
      items: all.slice(offset, offset + 2).map(publicValue),
      pageInfo: {
        ...(offset > 0 ? { previousCursor: 'page-1' } : {}),
        ...(offset + 2 < all.length ? { nextCursor: 'page-2' } : {}),
      },
    });
  },

  async createOrder(input, context): Promise<unknown> {
    assertOwner(context.ownerId);
    const fingerprint = JSON.stringify(input);
    return Promise.resolve(
      command(context.idempotencyKey, context.ownerId, `order:${fingerprint}`, () => {
        const packages = new Map([
          ['starter', { amountMinor: '9900', points: '10000' }],
          ['creator', { amountMinor: '29900', points: '32000' }],
          ['studio', { amountMinor: '89900', points: '100000' }],
        ]);
        const selected = input.packageId ? packages.get(input.packageId) : undefined;
        const custom = input.customAmountMinor;
        if ((selected ? 1 : 0) + (custom ? 1 : 0) !== 1)
          throw new CommerceCommandError('INVALID_RECHARGE_SELECTION');
        const amountMinor = selected?.amountMinor ?? custom ?? '';
        if (!/^\d+$/.test(amountMinor)) throw new CommerceCommandError('INVALID_RECHARGE_AMOUNT');
        const amount = BigInt(amountMinor);
        if (!selected && (amount < 100n || amount > 500000n || amount % 100n !== 0n))
          throw new CommerceCommandError('INVALID_RECHARGE_AMOUNT');
        const now = new Date();
        const order: Owned<RechargeOrderView> = {
          ownerId: context.ownerId,
          id: createUuidV7(now.getTime()),
          amountMinor,
          currency: 'CNY',
          points: selected?.points ?? amountMinor,
          status: 'PENDING',
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + 15 * 60_000).toISOString(),
        };
        orders.unshift(order);
        return {
          order: publicValue(order),
          payment: {
            environment: 'MOCK',
            kind: 'DISPLAY_ONLY',
            expiresAt: order.expiresAt,
          },
        };
      }),
    );
  },

  async requestOrderPayment(orderId, context): Promise<unknown> {
    assertOwner(context.ownerId);
    const order = orders.find(
      (candidate) => candidate.id === orderId && candidate.ownerId === context.ownerId,
    );
    if (
      !order ||
      order.status !== 'PENDING' ||
      !order.expiresAt ||
      Date.parse(order.expiresAt) <= Date.now() + 5_000
    ) {
      throw new CommerceCommandError('ORDER_NOT_PAYABLE');
    }
    return Promise.resolve({
      order: publicValue(order),
      payment: {
        environment: 'MOCK',
        kind: 'DISPLAY_ONLY',
        expiresAt: order.expiresAt,
      },
    });
  },

  async listInvoiceCandidates(context): Promise<unknown> {
    assertOwner(context.ownerId);
    return Promise.resolve({
      items: orders
        .filter(
          (order) =>
            order.ownerId === context.ownerId &&
            order.status === 'PAID' &&
            order.paidAt &&
            !invoicedOrders.has(`${context.ownerId}:${order.id}`),
        )
        .map((order) => ({
          orderId: order.id,
          paidAt: order.paidAt,
          amountMinor: order.amountMinor,
          currency: order.currency,
          points: order.points,
        })),
      history: invoices.filter((invoice) => invoice.ownerId === context.ownerId).map(publicValue),
    });
  },

  async createInvoice(input, context): Promise<unknown> {
    assertOwner(context.ownerId);
    return Promise.resolve(
      command(context.idempotencyKey, context.ownerId, `invoice:${JSON.stringify(input)}`, () => {
        const uniqueOrderIds = [...new Set(input.orderIds)];
        if (uniqueOrderIds.length === 0 || uniqueOrderIds.length !== input.orderIds.length)
          throw new CommerceCommandError('INVALID_INVOICE_ORDERS');
        if (uniqueOrderIds.some((orderId) => invoicedOrders.has(`${context.ownerId}:${orderId}`)))
          throw new CommerceCommandError('ORDER_NOT_INVOICE_ELIGIBLE');
        const eligible = uniqueOrderIds.map((id) =>
          orders.find(
            (order) =>
              order.id === id && order.ownerId === context.ownerId && order.status === 'PAID',
          ),
        );
        if (eligible.some((order) => !order))
          throw new CommerceCommandError('ORDER_NOT_INVOICE_ELIGIBLE');
        if (input.title.trim().length < 2 || input.title.length > 100)
          throw new CommerceCommandError('INVALID_INVOICE_TITLE');
        if (!/^[0-9A-Z]{15,20}$/.test(input.taxNumber))
          throw new CommerceCommandError('INVALID_TAX_NUMBER');
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254)
          throw new CommerceCommandError('INVALID_INVOICE_EMAIL');
        const now = new Date().toISOString();
        const invoice: Owned<InvoiceHistoryItem> = {
          ownerId: context.ownerId,
          id: createUuidV7(),
          amountMinor: eligible
            .reduce((total, order) => total + BigInt(order?.amountMinor ?? '0'), 0n)
            .toString(),
          currency: 'CNY',
          title: input.title.trim(),
          status: 'SUBMITTED',
          updatedAt: now,
          statusHistory: [{ status: 'SUBMITTED', occurredAt: now }],
        };
        invoices.unshift(invoice);
        for (const orderId of uniqueOrderIds) {
          invoicedOrders.add(`${context.ownerId}:${orderId}`);
        }
        return { id: invoice.id, status: invoice.status };
      }),
    );
  },
};
