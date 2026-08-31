/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment -- narrow Prisma structural boundary. */
import { isDeepStrictEqual } from 'node:util';
import { Prisma } from '@prisma/client';
import {
  PublicationError,
  type PublicationRepository,
  type PublicationScope,
  type PublicationState,
  type RechargePackageVersion,
  type RechargePackagePurchaseSnapshot,
  type ContentEntry,
  type ContentVersion,
  type BannerPlacement,
  type HelpCategory,
  type PublicSystemSettingVersion,
  type FeatureFlagVersion,
  type OperationsOutboxEvent,
  validateSystemSetting,
} from '../application/publication.service.js';

interface PrismaTransactionClient {
  rechargePackageVersion: any;
  rechargePackagePurchaseSnapshot: any;
  contentEntry: any;
  contentVersion: any;
  bannerPlacement: any;
  bannerSlotRevision: any;
  helpCategory: any;
  publicSystemSettingVersion: any;
  featureFlagVersion: any;
  outboxEvent: any;
}

export interface PrismaPublicationClient {
  $transaction<T>(work: (tx: PrismaTransactionClient) => Promise<T>): Promise<T>;
}

/**
 * Production unit-of-work adapter. Versioned rows use revision/status guards and
 * the outbox insert is executed before the enclosing Prisma transaction commits.
 */
export class PrismaPublicationRepository implements PublicationRepository {
  constructor(private readonly client: PrismaPublicationClient) {}

  snapshot(scope: PublicationScope): Promise<PublicationState> {
    return this.client.$transaction((tx) => loadState(tx, scope));
  }

  async transact<T>(scope: PublicationScope, work: (state: PublicationState) => T | Promise<T>): Promise<T> {
    try {
      return await this.client.$transaction(async (tx) => {
      const before = await loadState(tx, scope);
      const after = structuredClone(before);
      const result = await work(after);
      await persistState(tx, before, after);
      return result;
      });
    } catch (error) {
      if (isUniqueConflict(error)) throw new PublicationError('VERSION_CONFLICT');
      throw error;
    }
  }
}

async function loadState(tx: PrismaTransactionClient, scope: PublicationScope): Promise<PublicationState> {
  if (scope.kind === 'all') return loadAllState(tx);
  const state = emptyState();
  if (scope.kind === 'package') await loadPackageScope(tx, state, scope);
  if (scope.kind === 'content') await loadContentScope(tx, state, scope);
  if (scope.kind === 'setting') await loadSettingScope(tx, state, scope);
  if (scope.kind === 'flag') await loadFlagScope(tx, state, scope);
  return state;
}

async function loadAllState(tx: PrismaTransactionClient): Promise<PublicationState> {
  const [packages, purchases, entries, content, placements, slotRevisions, categories, settings, flags, outbox] = await Promise.all([
    tx.rechargePackageVersion.findMany(), tx.rechargePackagePurchaseSnapshot.findMany(), tx.contentEntry.findMany(),
    tx.contentVersion.findMany(), tx.bannerPlacement.findMany(), tx.bannerSlotRevision.findMany(),
    tx.helpCategory.findMany(), tx.publicSystemSettingVersion.findMany(), tx.featureFlagVersion.findMany(), tx.outboxEvent.findMany(),
  ]);
  return {
    packages: mapById(packages as RechargePackageVersion[]),
    purchases: new Map((purchases as RechargePackagePurchaseSnapshot[]).map((row) => [row.purchaseId, structuredClone(row)])),
    entries: mapById(entries as ContentEntry[]),
    content: mapById(content as ContentVersion[]),
    placements: mapById(placements as BannerPlacement[]),
    slotRevisions: new Map((slotRevisions as Array<{ slot: string; revision: number }>).map((row) => [row.slot, row.revision])),
    categories: mapById(categories as HelpCategory[]),
    settings: mapById(settings as PublicSystemSettingVersion[]),
    flags: mapById(flags as FeatureFlagVersion[]),
    outbox: (outbox as Array<Omit<OperationsOutboxEvent, 'occurredAt' | 'causationId'> & { occurredAt: Date | string; causationId?: string | null }>).map((row) => {
      const { causationId, ...rest } = structuredClone(row);
      return { ...rest, occurredAt: row.occurredAt instanceof Date ? row.occurredAt.toISOString() : row.occurredAt,
        ...(causationId == null ? {} : { causationId }) };
    }),
  };
}

async function loadPackageScope(tx: PrismaTransactionClient, state: PublicationState, scope: Extract<PublicationScope, { kind: 'package' }>): Promise<void> {
  if (scope.versionId !== undefined) {
    const target = await tx.rechargePackageVersion.findUnique({ where: { id: scope.versionId } }) as RechargePackageVersion | null;
    if (target !== null) addRows(state.packages, await tx.rechargePackageVersion.findMany({ where: { packageId: target.packageId } }) as RechargePackageVersion[]);
  } else if (scope.publicAt !== undefined) {
    addRows(state.packages, await tx.rechargePackageVersion.findMany({ where: activeWhere(scope.publicAt), orderBy: [{ sortOrder: 'asc' }, { version: 'asc' }] }) as RechargePackageVersion[]);
  }
  if (scope.purchaseId !== undefined) {
    const purchase = await tx.rechargePackagePurchaseSnapshot.findUnique({ where: { purchaseId: scope.purchaseId } }) as RechargePackagePurchaseSnapshot | null;
    if (purchase !== null) state.purchases.set(purchase.purchaseId, structuredClone(purchase));
  }
}

async function loadContentScope(tx: PrismaTransactionClient, state: PublicationState, scope: Extract<PublicationScope, { kind: 'content' }>): Promise<void> {
  const categoryIds = new Set<string>();
  if (scope.versionId !== undefined) {
    const target = await tx.contentVersion.findUnique({ where: { id: scope.versionId } }) as ContentVersion | null;
    if (target !== null) {
      const versions = await tx.contentVersion.findMany({ where: { entryId: target.entryId } }) as ContentVersion[];
      addRows(state.content, versions);
      const entry = await tx.contentEntry.findUnique({ where: { id: target.entryId } }) as ContentEntry | null;
      if (entry !== null) state.entries.set(entry.id, structuredClone(entry));
      for (const row of versions) if (row.helpCategoryId !== null) categoryIds.add(row.helpCategoryId);
    }
  }
  if (scope.entryId !== undefined) {
    const entry = await tx.contentEntry.findUnique({ where: { id: scope.entryId } }) as ContentEntry | null;
    if (entry !== null) state.entries.set(entry.id, structuredClone(entry));
    const versions = await tx.contentVersion.findMany({ where: { entryId: scope.entryId } }) as ContentVersion[];
    addRows(state.content, versions);
    for (const row of versions) if (row.helpCategoryId !== null) categoryIds.add(row.helpCategoryId);
  }
  if (scope.entryKind !== undefined && scope.entryKey !== undefined) {
    addRows(state.entries, await tx.contentEntry.findMany({ where: { kind: scope.entryKind, key: scope.entryKey } }) as ContentEntry[]);
  }
  if (scope.publicKind !== undefined && scope.publicAt !== undefined) {
    const versions = await tx.contentVersion.findMany({ where: { entry: { kind: scope.publicKind }, ...activeWhere(scope.publicAt) }, orderBy: [{ sortOrder: 'asc' }, { version: 'asc' }] }) as ContentVersion[];
    addRows(state.content, versions);
    const entryIds = [...new Set(versions.map((row) => row.entryId))];
    if (entryIds.length > 0) addRows(state.entries, await tx.contentEntry.findMany({ where: { id: { in: entryIds } } }) as ContentEntry[]);
    for (const row of versions) if (row.helpCategoryId !== null) categoryIds.add(row.helpCategoryId);
  }
  if (scope.slot !== undefined) {
    const placements = await tx.bannerPlacement.findMany({ where: { slot: scope.slot, ...(scope.publicAt === undefined ? {} : windowWhere(scope.publicAt)) } }) as BannerPlacement[];
    addRows(state.placements, placements);
    const slotRow = await tx.bannerSlotRevision.findUnique({ where: { slot: scope.slot } }) as { slot: string; revision: number } | null;
    if (slotRow !== null) state.slotRevisions.set(slotRow.slot, slotRow.revision);
    const versionIds = placements.map((row) => row.contentVersionId);
    const versions = versionIds.length === 0 ? [] : await tx.contentVersion.findMany({ where: { id: { in: versionIds } } }) as ContentVersion[];
    addRows(state.content, versions);
    const entryIds = [...new Set(versions.map((row) => row.entryId))];
    if (entryIds.length > 0) addRows(state.entries, await tx.contentEntry.findMany({ where: { id: { in: entryIds } } }) as ContentEntry[]);
  }
  if (scope.categoryId !== undefined && scope.categoryId !== null) categoryIds.add(scope.categoryId);
  if (scope.categoryKey !== undefined) addRows(state.categories, await tx.helpCategory.findMany({ where: { key: scope.categoryKey } }) as HelpCategory[]);
  if (categoryIds.size > 0) addRows(state.categories, await tx.helpCategory.findMany({ where: { id: { in: [...categoryIds] } } }) as HelpCategory[]);
}

async function loadSettingScope(tx: PrismaTransactionClient, state: PublicationState, scope: Extract<PublicationScope, { kind: 'setting' }>): Promise<void> {
  if (scope.versionId !== undefined) {
    const target = await tx.publicSystemSettingVersion.findUnique({ where: { id: scope.versionId } }) as PublicSystemSettingVersion | null;
    if (target !== null) addRows(state.settings, await tx.publicSystemSettingVersion.findMany({ where: { settingKey: target.settingKey } }) as PublicSystemSettingVersion[]);
  } else if (scope.settingKey !== undefined) addRows(state.settings, await tx.publicSystemSettingVersion.findMany({ where: { settingKey: scope.settingKey } }) as PublicSystemSettingVersion[]);
}

async function loadFlagScope(tx: PrismaTransactionClient, state: PublicationState, scope: Extract<PublicationScope, { kind: 'flag' }>): Promise<void> {
  if (scope.versionId !== undefined) {
    const target = await tx.featureFlagVersion.findUnique({ where: { id: scope.versionId } }) as FeatureFlagVersion | null;
    if (target !== null) addRows(state.flags, await tx.featureFlagVersion.findMany({ where: { flagKey: target.flagKey } }) as FeatureFlagVersion[]);
  } else if (scope.flagKey !== undefined) addRows(state.flags, await tx.featureFlagVersion.findMany({ where: { flagKey: scope.flagKey } }) as FeatureFlagVersion[]);
}

async function persistState(tx: PrismaTransactionClient, before: PublicationState, after: PublicationState): Promise<void> {
  validateBannerCollectionRevision(before, after);
  await persistCreated(tx.contentEntry, before.entries, after.entries);
  await persistCreated(tx.helpCategory, before.categories, after.categories);

  await persistVersioned(tx.rechargePackageVersion, before.packages, after.packages);
  await persistVersioned(tx.contentVersion, before.content, after.content);
  await persistVersioned(tx.publicSystemSettingVersion, before.settings, after.settings, settingData);
  await persistVersioned(tx.featureFlagVersion, before.flags, after.flags);

  await persistCreated(tx.rechargePackagePurchaseSnapshot, before.purchases, after.purchases);
  await persistSlotRevisions(tx.bannerSlotRevision, before.slotRevisions, after.slotRevisions);
  await persistPlacements(tx.bannerPlacement, before.placements, after.placements);

  const existingEvents = new Set(before.outbox.map((row) => row.id));
  for (const event of after.outbox) {
    if (existingEvents.has(event.id)) continue;
    await tx.outboxEvent.create({ data: {
      ...event, nextAttemptAt: event.createdAt, claimToken: null, leaseUntil: null,
      lastError: null, publishedAt: null,
    } });
  }
}

function validateBannerCollectionRevision(before: PublicationState, after: PublicationState): void {
  const changedSlots = new Set<string>();
  for (const [id, row] of after.placements) {
    const previous = before.placements.get(id);
    if (previous === undefined || !isDeepStrictEqual(previous, row)) { changedSlots.add(row.slot); if (previous !== undefined) changedSlots.add(previous.slot); }
  }
  for (const [id, row] of before.placements) if (!after.placements.has(id)) changedSlots.add(row.slot);
  for (const slot of changedSlots) if ((after.slotRevisions.get(slot) ?? 0) !== (before.slotRevisions.get(slot) ?? 0) + 1) throw new PublicationError('VERSION_CONFLICT');
  const occupied = new Set<string>();
  for (const row of after.placements.values()) {
    const key = `${row.slot}\u0000${String(row.sortOrder)}`;
    if (occupied.has(key)) throw new PublicationError('BANNER_SORT_ORDER_CONFLICT');
    occupied.add(key);
  }
}

async function persistCreated<T>(delegate: any, before: Map<string, T>, after: Map<string, T>): Promise<void> {
  for (const [id, row] of after) {
    const previous = before.get(id);
    if (previous === undefined) await delegate.create({ data: row });
    else if (!isDeepStrictEqual(previous, row)) throw new PublicationError('IMMUTABLE_RECORD_MODIFIED');
  }
}

async function persistVersioned<T extends { id: string; revision: number; status: string }>(
  delegate: any,
  before: Map<string, T>,
  after: Map<string, T>,
  data: (row: T) => Record<string, unknown> = mutableData,
): Promise<void> {
  for (const [id, row] of after) {
    const previous = before.get(id);
    if (previous === undefined) {
      await delegate.create({ data: data(row) });
      continue;
    }
    if (isDeepStrictEqual(previous, row)) continue;
    const changed = await delegate.updateMany({
      where: { id, revision: previous.revision, status: previous.status },
      data: data(row),
    });
    if (changed.count !== 1) throw new PublicationError('VERSION_CONFLICT');
  }
}

async function persistSlotRevisions(delegate: any, before: Map<string, number>, after: Map<string, number>): Promise<void> {
  for (const [slot, revision] of after) {
    const previous = before.get(slot);
    if (previous === undefined) await delegate.create({ data: { slot, revision } });
    else if (previous !== revision) {
      const changed = await delegate.updateMany({ where: { slot, revision: previous }, data: { revision } });
      if (changed.count !== 1) throw new PublicationError('VERSION_CONFLICT');
    }
  }
}

async function persistPlacements(delegate: any, before: Map<string, BannerPlacement>, after: Map<string, BannerPlacement>): Promise<void> {
  for (const [id, row] of after) {
    const previous = before.get(id);
    if (previous === undefined) await delegate.create({ data: row });
    else if (!isDeepStrictEqual(previous, row)) {
      const changed = await delegate.updateMany({ where: { id, slot: previous.slot }, data: mutableData(row) });
      if (changed.count !== 1) throw new PublicationError('VERSION_CONFLICT');
    }
  }
}

function mutableData(row: object): Record<string, unknown> {
  const data = { ...row } as Record<string, unknown>;
  delete data.id;
  return data;
}

function settingData(row: PublicSystemSettingVersion): Record<string, unknown> {
  validateSystemSetting(row.settingKey, row.kmsSecretReferenceId === null ? { publicValue: row.publicValue } : { kmsSecretReferenceId: row.kmsSecretReferenceId });
  const data = mutableData(row);
  if (row.publicValue === null) data.publicValue = Prisma.DbNull;
  return data;
}

function mapById<T extends { id: string }>(rows: T[]): Map<string, T> {
  return new Map(rows.map((row) => [row.id, structuredClone(row)]));
}

function addRows<T extends { id: string }>(target: Map<string, T>, rows: T[]): void {
  for (const row of rows) target.set(row.id, structuredClone(row));
}

function activeWhere(at: Date): Record<string, unknown> {
  return {
    status: 'PUBLISHED',
    ...windowWhere(at),
  };
}

function windowWhere(at: Date): Record<string, unknown> {
  return { AND: [{ OR: [{ activeFrom: null }, { activeFrom: { lte: at } }] }, { OR: [{ activeUntil: null }, { activeUntil: { gt: at } }] }] };
}

function emptyState(): PublicationState {
  return {
    packages: new Map(), purchases: new Map(), entries: new Map(), content: new Map(),
    placements: new Map(), slotRevisions: new Map(), categories: new Map(), settings: new Map(),
    flags: new Map(), outbox: [],
  };
}

function isUniqueConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = 'code' in error ? String(error.code) : '';
  return code === 'P2002' || code === '23505';
}
