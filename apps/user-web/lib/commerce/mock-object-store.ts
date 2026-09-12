import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { UuidSchema } from '@repo/contracts/common';

import { createUuidV7 } from '../tasks/identifiers';
import { requireMockCommerceSigningKey } from './mock-config';
import { matchesMockUploadSignature } from './mock-upload-boundary';
import type { AssetListItem, VerifiedUploadGrant, VerifiedUploadReceipt } from './types';

const STORE_VERSION = 1;
const STORE_TTL_MS = 24 * 60 * 60_000;
const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 1024n * 1024n * 1024n;
const STORAGE_KEY = /^[a-f0-9]{64}$/;
const STORE_LOCK_ATTEMPTS = 200;

// This deliberately local mock store is single-host only; live deployments must use the Gateway's
// object storage implementation rather than sharing or promoting this temporary directory.

export type MockObjectState = 'UPLOADING' | 'STORED' | 'AVAILABLE';

export interface MockObjectMetadata {
  readonly version: 1;
  readonly ownerId: string;
  readonly assetId: string;
  readonly grantId: string;
  readonly idempotencyKey: string;
  readonly storageKey: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: string;
  readonly sha256?: string;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly state: MockObjectState;
}

export class MockObjectStoreError extends Error {
  readonly outcome: 'DEFINITIVE_FAILURE' | 'UNCERTAIN';

  constructor(
    readonly code: 'CAPACITY' | 'CONTENT_MISMATCH' | 'INVALID' | 'LOCK_UNAVAILABLE' | 'NOT_FOUND',
  ) {
    super(`MOCK_OBJECT_${code}`);
    this.outcome = code === 'LOCK_UNAVAILABLE' ? 'UNCERTAIN' : 'DEFINITIVE_FAILURE';
  }
}

function storeRoot(): string {
  void requireMockCommerceSigningKey();
  const root = resolve(tmpdir(), 'ai-video-user-web-commerce-mock-v1');
  const temporaryRoot = resolve(tmpdir());
  if (!isAbsolute(root) || !root.startsWith(`${temporaryRoot}${sep}`)) {
    throw new MockObjectStoreError('INVALID');
  }
  return root;
}

function storeAuxiliaryPath(file: string): string {
  if (!/^\.[a-z0-9-]+$/.test(file)) throw new MockObjectStoreError('INVALID');
  const root = storeRoot();
  const target = resolve(root, file);
  if (dirname(target) !== root || basename(target) !== file) {
    throw new MockObjectStoreError('INVALID');
  }
  return target;
}

function objectPath(storageKey: string, extension: '.bin' | '.json'): string {
  if (!STORAGE_KEY.test(storageKey)) throw new MockObjectStoreError('INVALID');
  const root = storeRoot();
  const target = resolve(root, `${storageKey}${extension}`);
  if (dirname(target) !== root || basename(target) !== `${storageKey}${extension}`) {
    throw new MockObjectStoreError('INVALID');
  }
  return target;
}

async function removeIfPresent(path: string): Promise<void> {
  await unlink(path).catch((error: unknown) => {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  });
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

interface StoreLockOwner {
  readonly version: 1;
  readonly pid: number;
  readonly token: string;
  readonly createdAt: string;
}

function lockOwnerPath(directory: string): string {
  const root = storeRoot();
  if (dirname(directory) !== root) throw new MockObjectStoreError('INVALID');
  const target = resolve(directory, 'owner.json');
  if (dirname(target) !== directory || basename(target) !== 'owner.json') {
    throw new MockObjectStoreError('INVALID');
  }
  return target;
}

function parseLockOwner(value: unknown): StoreLockOwner | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const owner = value as Record<string, unknown>;
  if (
    Object.keys(owner).sort().join(',') !== 'createdAt,pid,token,version' ||
    owner.version !== 1 ||
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    owner.pid > 2_147_483_647 ||
    typeof owner.token !== 'string' ||
    !UuidSchema.safeParse(owner.token).success ||
    typeof owner.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(owner.createdAt))
  ) {
    return undefined;
  }
  return owner as unknown as StoreLockOwner;
}

async function readLockOwner(directory: string): Promise<StoreLockOwner | undefined> {
  try {
    return parseLockOwner(JSON.parse(await readFile(lockOwnerPath(directory), 'utf8')));
  } catch {
    return undefined;
  }
}

function processLiveness(pid: number): 'ALIVE' | 'DEAD' | 'UNKNOWN' {
  try {
    process.kill(pid, 0);
    return 'ALIVE';
  } catch (error) {
    if (hasErrorCode(error, 'ESRCH')) return 'DEAD';
    return 'UNKNOWN';
  }
}

async function tryAcquireStoreLock(lockPath: string): Promise<StoreLockOwner | undefined> {
  const owner: StoreLockOwner = {
    version: 1,
    pid: process.pid,
    token: createUuidV7(),
    createdAt: new Date().toISOString(),
  };
  const candidatePath = storeAuxiliaryPath(`.store-lock-candidate-${owner.token}`);
  await mkdir(candidatePath);
  try {
    const handle = await open(lockOwnerPath(candidatePath), 'wx');
    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(candidatePath, lockPath);
      return owner;
    } catch (error) {
      const occupied = await stat(lockPath).catch(() => undefined);
      if (!occupied) throw error;
      return undefined;
    }
  } finally {
    await rm(candidatePath, { force: true, recursive: true }).catch(() => undefined);
  }
}

async function recoverDeadStoreLock(
  lockPath: string,
  liveness: (pid: number) => 'ALIVE' | 'DEAD' | 'UNKNOWN' = processLiveness,
): Promise<boolean> {
  const owner = await readLockOwner(lockPath);
  if (!owner || liveness(owner.pid) !== 'DEAD') return false;
  const quarantinePath = storeAuxiliaryPath(`.store-lock-quarantine-${owner.token}`);
  try {
    await rename(lockPath, quarantinePath);
    return true;
  } catch {
    return false;
  }
}

async function releaseStoreLock(lockPath: string, owner: StoreLockOwner): Promise<void> {
  const current = await readLockOwner(lockPath);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) {
    throw new MockObjectStoreError('LOCK_UNAVAILABLE');
  }
  const releasePath = storeAuxiliaryPath(`.store-lock-release-${owner.token}`);
  await rename(lockPath, releasePath);
  await rm(releasePath, { force: true, recursive: true });
}

interface StoreLockPolicy {
  readonly attempts?: number;
  readonly liveness?: (pid: number) => 'ALIVE' | 'DEAD' | 'UNKNOWN';
}

async function withStoreLock<T>(
  operation: () => Promise<T>,
  policy: StoreLockPolicy = {},
): Promise<T> {
  const root = storeRoot();
  await mkdir(root, { recursive: true });
  const lockPath = storeAuxiliaryPath('.store-lock');
  let owner: StoreLockOwner | undefined;
  const attempts = policy.attempts ?? STORE_LOCK_ATTEMPTS;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > STORE_LOCK_ATTEMPTS) {
    throw new MockObjectStoreError('INVALID');
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    owner = await tryAcquireStoreLock(lockPath);
    if (owner) break;
    if (await recoverDeadStoreLock(lockPath, policy.liveness)) continue;
    await delay(25);
  }
  if (!owner) throw new MockObjectStoreError('LOCK_UNAVAILABLE');
  try {
    return await operation();
  } finally {
    await releaseStoreLock(lockPath, owner);
  }
}

export async function writeChunkFully(
  handle: {
    write: (
      bytes: Uint8Array,
      offset: number,
      length: number,
      position?: number | null,
    ) => Promise<{ bytesWritten: number }>;
  },
  bytes: Uint8Array,
): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset, null);
    if (
      !Number.isInteger(bytesWritten) ||
      bytesWritten <= 0 ||
      bytesWritten > bytes.byteLength - offset
    ) {
      throw new MockObjectStoreError('INVALID');
    }
    offset += bytesWritten;
  }
}

function parseMetadata(value: unknown): MockObjectMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MockObjectStoreError('INVALID');
  }
  const item = value as Record<string, unknown>;
  const allowed = [
    'version',
    'ownerId',
    'assetId',
    'grantId',
    'idempotencyKey',
    'storageKey',
    'name',
    'mimeType',
    'sizeBytes',
    'sha256',
    'createdAt',
    'expiresAt',
    'state',
  ];
  if (Object.keys(item).some((key) => !allowed.includes(key))) {
    throw new MockObjectStoreError('INVALID');
  }
  if (
    item.version !== STORE_VERSION ||
    typeof item.ownerId !== 'string' ||
    !UuidSchema.safeParse(item.ownerId).success ||
    typeof item.assetId !== 'string' ||
    !UuidSchema.safeParse(item.assetId).success ||
    typeof item.grantId !== 'string' ||
    !UuidSchema.safeParse(item.grantId).success ||
    typeof item.idempotencyKey !== 'string' ||
    !UuidSchema.safeParse(item.idempotencyKey).success ||
    typeof item.storageKey !== 'string' ||
    !STORAGE_KEY.test(item.storageKey) ||
    typeof item.name !== 'string' ||
    !item.name.trim() ||
    item.name.length > 120 ||
    typeof item.mimeType !== 'string' ||
    !/^(?:image\/(?:jpeg|png|webp)|video\/(?:mp4|webm|quicktime))$/.test(item.mimeType) ||
    typeof item.sizeBytes !== 'string' ||
    !/^\d+$/.test(item.sizeBytes) ||
    (item.sha256 !== undefined &&
      (typeof item.sha256 !== 'string' || !STORAGE_KEY.test(item.sha256))) ||
    typeof item.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    typeof item.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(item.expiresAt)) ||
    (item.state !== 'UPLOADING' && item.state !== 'STORED' && item.state !== 'AVAILABLE')
  ) {
    throw new MockObjectStoreError('INVALID');
  }
  const expectedStorageKey = createHash('sha256')
    .update(`mock-object:v1:${item.ownerId}:${item.assetId}`, 'utf8')
    .digest('hex');
  if (
    item.assetId !== item.grantId ||
    item.assetId !== item.idempotencyKey ||
    item.storageKey !== expectedStorageKey ||
    (item.state === 'UPLOADING' ? item.sha256 !== undefined : item.sha256 === undefined)
  ) {
    throw new MockObjectStoreError('INVALID');
  }
  return item as unknown as MockObjectMetadata;
}

async function readMetadata(storageKey: string): Promise<MockObjectMetadata | undefined> {
  try {
    return parseMetadata(JSON.parse(await readFile(objectPath(storageKey, '.json'), 'utf8')));
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeMetadata(metadata: MockObjectMetadata): Promise<void> {
  const target = objectPath(metadata.storageKey, '.json');
  await mkdir(dirname(target), { recursive: true });
  const temporary = resolve(dirname(target), `${metadata.storageKey}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await removeIfPresent(temporary).catch(() => undefined);
    throw error;
  }
}

async function removeObjectFiles(storageKey: string): Promise<void> {
  await removeIfPresent(objectPath(storageKey, '.bin'));
  await removeIfPresent(objectPath(storageKey, '.json'));
}

async function cleanupUnlocked(now = Date.now()): Promise<MockObjectMetadata[]> {
  const root = storeRoot();
  await mkdir(root, { recursive: true });
  const files = await readdir(root);
  const metadata: MockObjectMetadata[] = [];
  for (const file of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
    const storageKey = file.slice(0, 64);
    try {
      const item = await readMetadata(storageKey);
      if (!item) continue;
      if (Date.parse(item.expiresAt) <= now) {
        await removeObjectFiles(storageKey);
      } else {
        const content =
          item.state === 'UPLOADING'
            ? undefined
            : await stat(objectPath(storageKey, '.bin')).catch(() => undefined);
        if (
          item.state !== 'UPLOADING' &&
          (!content?.isFile() || BigInt(content.size) !== BigInt(item.sizeBytes))
        ) {
          await removeObjectFiles(storageKey);
        } else {
          metadata.push(item);
        }
      }
    } catch {
      await removeObjectFiles(storageKey);
    }
  }
  const validContentKeys = new Set(
    metadata.filter((item) => item.state !== 'UPLOADING').map((item) => item.storageKey),
  );
  for (const file of await readdir(root)) {
    const contentMatch = /^([a-f0-9]{64})\.bin$/.exec(file);
    if (contentMatch) {
      const storageKey = contentMatch[1];
      if (storageKey && !validContentKeys.has(storageKey)) {
        await removeIfPresent(objectPath(storageKey, '.bin'));
      }
      continue;
    }
    if (!/^[a-f0-9]{64}\.[0-9a-f-]+\.(?:partial|tmp)$/.test(file)) continue;
    const target = resolve(root, file);
    if (dirname(target) !== root || basename(target) !== file) continue;
    const fileStat = await stat(target).catch(() => undefined);
    if (fileStat && now - fileStat.mtimeMs > STORE_TTL_MS) await removeIfPresent(target);
  }
  return metadata;
}

function matchesGrant(metadata: MockObjectMetadata, grant: VerifiedUploadGrant): boolean {
  return (
    metadata.ownerId === grant.ownerId &&
    metadata.assetId === grant.assetId &&
    metadata.grantId === grant.grantId &&
    metadata.idempotencyKey === grant.idempotencyKey &&
    metadata.storageKey === grant.storageKey &&
    metadata.name === grant.name &&
    metadata.mimeType === grant.mimeType &&
    metadata.sizeBytes === grant.sizeBytes
  );
}

export async function reserveMockUpload(
  grant: VerifiedUploadGrant,
  lockPolicy: StoreLockPolicy = {},
): Promise<void> {
  await withStoreLock(async () => {
    const current = await cleanupUnlocked();
    const existing = current.find((item) => item.storageKey === grant.storageKey);
    if (existing) {
      if (!matchesGrant(existing, grant)) throw new MockObjectStoreError('INVALID');
      return;
    }
    const total = current.reduce((sum, item) => sum + BigInt(item.sizeBytes), 0n);
    if (current.length >= MAX_FILES || total + BigInt(grant.sizeBytes) > MAX_TOTAL_BYTES) {
      throw new MockObjectStoreError('CAPACITY');
    }
    const createdAt = new Date().toISOString();
    await writeMetadata({
      version: STORE_VERSION,
      ownerId: grant.ownerId,
      assetId: grant.assetId,
      grantId: grant.grantId,
      idempotencyKey: grant.idempotencyKey,
      storageKey: grant.storageKey,
      name: grant.name,
      mimeType: grant.mimeType,
      sizeBytes: grant.sizeBytes,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + STORE_TTL_MS).toISOString(),
      state: 'UPLOADING',
    });
  }, lockPolicy);
}

export async function storeMockUpload(
  grant: VerifiedUploadGrant,
  body: ReadableStream<Uint8Array>,
): Promise<string> {
  const metadata = await withStoreLock(() => readMetadata(grant.storageKey));
  if (!metadata || !matchesGrant(metadata, grant)) throw new MockObjectStoreError('NOT_FOUND');
  const contentPath = objectPath(grant.storageKey, '.bin');
  const temporary = resolve(dirname(contentPath), `${grant.storageKey}.${randomUUID()}.partial`);
  const handle = await open(temporary, 'wx');
  const reader = body.getReader();
  const hash = createHash('sha256');
  const signature = new Uint8Array(64 * 1_024);
  let signatureLength = 0;
  let actual = 0n;
  const publishState = { content: false };
  try {
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        continue;
      }
      actual += BigInt(chunk.value.byteLength);
      if (actual > BigInt(grant.sizeBytes)) throw new MockObjectStoreError('INVALID');
      if (signatureLength < signature.length) {
        const prefix = chunk.value.subarray(0, signature.length - signatureLength);
        signature.set(prefix, signatureLength);
        signatureLength += prefix.byteLength;
      }
      hash.update(chunk.value);
      await writeChunkFully(handle, chunk.value);
    }
    if (actual !== BigInt(grant.sizeBytes)) throw new MockObjectStoreError('INVALID');
    if (
      !matchesMockUploadSignature(
        grant.name,
        grant.mimeType,
        signature.subarray(0, signatureLength),
        actual,
      )
    ) {
      throw new MockObjectStoreError('CONTENT_MISMATCH');
    }
    await handle.sync();
    await handle.close();
    const sha256 = hash.digest('hex');
    return await withStoreLock(async () => {
      const current = await readMetadata(grant.storageKey);
      if (!current || !matchesGrant(current, grant)) throw new MockObjectStoreError('NOT_FOUND');
      if ((current.state === 'STORED' || current.state === 'AVAILABLE') && current.sha256) {
        const existingContent = await stat(contentPath).catch(() => undefined);
        if (
          existingContent?.isFile() &&
          BigInt(existingContent.size) === BigInt(current.sizeBytes) &&
          current.sha256 === sha256
        ) {
          await removeIfPresent(temporary);
          return current.sha256;
        }
        throw new MockObjectStoreError('INVALID');
      }
      await rename(temporary, contentPath);
      publishState.content = true;
      await writeMetadata({ ...current, sha256, state: 'STORED' });
      return sha256;
    });
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await removeIfPresent(temporary).catch(() => undefined);
    if (publishState.content) {
      await withStoreLock(() => removeIfPresent(contentPath)).catch(() => undefined);
    }
    throw error;
  }
}

export async function completeMockUpload(receipt: VerifiedUploadReceipt): Promise<AssetListItem> {
  return withStoreLock(async () => {
    const metadata = await readMetadata(receipt.storageKey);
    if (
      !metadata ||
      !matchesGrant(metadata, receipt) ||
      metadata.sha256 !== receipt.sha256 ||
      (metadata.state !== 'STORED' && metadata.state !== 'AVAILABLE')
    ) {
      throw new MockObjectStoreError('NOT_FOUND');
    }
    const stored = await stat(objectPath(receipt.storageKey, '.bin')).catch(() => undefined);
    if (!stored?.isFile() || BigInt(stored.size) !== BigInt(receipt.sizeBytes)) {
      throw new MockObjectStoreError('NOT_FOUND');
    }
    if (metadata.state !== 'AVAILABLE') await writeMetadata({ ...metadata, state: 'AVAILABLE' });
    return {
      id: metadata.assetId,
      kind: 'UPLOAD',
      name: metadata.name,
      mimeType: metadata.mimeType,
      sizeBytes: metadata.sizeBytes,
      createdAt: metadata.createdAt,
      posterAlt: `${metadata.name} 素材预览`,
    };
  });
}

export async function listMockObjects(ownerId: string): Promise<MockObjectMetadata[]> {
  return withStoreLock(async () =>
    (await cleanupUnlocked()).filter(
      (item) => item.ownerId === ownerId && item.state === 'AVAILABLE',
    ),
  );
}

export async function findMockObject(
  assetId: string,
  ownerId: string,
): Promise<MockObjectMetadata | undefined> {
  return (await listMockObjects(ownerId)).find((item) => item.assetId === assetId);
}

export async function renameMockObject(
  assetId: string,
  ownerId: string,
  name: string,
): Promise<AssetListItem | undefined> {
  return withStoreLock(async () => {
    const metadata = (await cleanupUnlocked()).find(
      (item) => item.assetId === assetId && item.ownerId === ownerId && item.state === 'AVAILABLE',
    );
    if (!metadata) return undefined;
    const renamed = { ...metadata, name };
    await writeMetadata(renamed);
    return {
      id: renamed.assetId,
      kind: 'UPLOAD',
      name: renamed.name,
      mimeType: renamed.mimeType,
      sizeBytes: renamed.sizeBytes,
      createdAt: renamed.createdAt,
      posterAlt: `${renamed.name} 素材预览`,
    };
  });
}

export async function deleteMockObject(assetId: string, ownerId: string): Promise<boolean> {
  return withStoreLock(async () => {
    const metadata = (await cleanupUnlocked()).find(
      (item) => item.assetId === assetId && item.ownerId === ownerId && item.state === 'AVAILABLE',
    );
    if (!metadata) return false;
    await removeObjectFiles(metadata.storageKey);
    return true;
  });
}

export function mockObjectContentPath(metadata: MockObjectMetadata): string {
  return objectPath(metadata.storageKey, '.bin');
}
