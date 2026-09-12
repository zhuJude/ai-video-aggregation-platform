import 'server-only';

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { UuidSchema } from '@repo/contracts/common';

import { createUuidV7 } from '../tasks/identifiers';
import { requireMockCommerceSigningKey } from './mock-config';
import { matchesMockUploadSignature } from './mock-upload-boundary';
import type { AssetListItem, VerifiedUploadGrant, VerifiedUploadReceipt } from './types';

const STORE_VERSION = 1;
const OBJECT_TTL_MS = 24 * 60 * 60_000;
const UPLOAD_RESERVATION_TTL_MS = 2 * 60 * 60_000 + 5 * 60_000;
const AUXILIARY_TTL_MS = 10 * 60_000;
const COMMAND_TTL_MS = 24 * 60 * 60_000;
const MAX_COMMANDS = 1_000;
const MAX_SEED_SUPPRESSIONS = 100;
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
  readonly kind: 'UPLOAD' | 'RESULT';
  readonly source: 'UPLOAD' | 'SEED';
}

export class MockObjectStoreError extends Error {
  readonly outcome: 'DEFINITIVE_FAILURE' | 'UNCERTAIN';

  constructor(
    readonly code:
      | 'CAPACITY'
      | 'CONTENT_MISMATCH'
      | 'COMMAND_PENDING'
      | 'IDEMPOTENCY_CONFLICT'
      | 'INVALID'
      | 'LOCK_UNAVAILABLE'
      | 'NOT_FOUND',
  ) {
    super(`MOCK_OBJECT_${code}`);
    this.outcome =
      code === 'LOCK_UNAVAILABLE' || code === 'COMMAND_PENDING'
        ? 'UNCERTAIN'
        : 'DEFINITIVE_FAILURE';
  }
}

function storeRoot(): string {
  void requireMockCommerceSigningKey();
  const testNamespace = process.env.USER_WEB_COMMERCE_MOCK_TEST_NAMESPACE;
  if (
    testNamespace &&
    ((process.env.NODE_ENV !== 'test' && process.env.USER_WEB_E2E_MODE !== '1') ||
      !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(testNamespace))
  ) {
    throw new MockObjectStoreError('INVALID');
  }
  const directoryName = testNamespace
    ? `ai-video-user-web-commerce-mock-v1-test-${testNamespace}`
    : 'ai-video-user-web-commerce-mock-v1';
  const root = resolve(tmpdir(), directoryName);
  const temporaryRoot = resolve(tmpdir());
  if (!isAbsolute(root) || !root.startsWith(`${temporaryRoot}${sep}`)) {
    throw new MockObjectStoreError('INVALID');
  }
  return root;
}

function samePath(first: string, second: string): boolean {
  return process.platform === 'win32'
    ? first.toLocaleLowerCase('en-US') === second.toLocaleLowerCase('en-US')
    : first === second;
}

async function ensureStoreRoot(): Promise<string> {
  const root = storeRoot();
  const realTemporaryRoot = await realpath(resolve(tmpdir()));
  const expected = resolve(realTemporaryRoot, basename(root));
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(root);
  const actual = await realpath(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || !samePath(actual, expected)) {
    throw new MockObjectStoreError('INVALID');
  }
  await chmod(root, 0o700).catch(() => undefined);
  return root;
}

type FileIdentity = { readonly dev: number; readonly ino: number };
type OpenFile = (path: string, flags: number) => ReturnType<typeof open>;

function sameFileIdentity(first: FileIdentity, second: FileIdentity): boolean {
  return (
    first.ino !== 0 && second.ino !== 0 && first.dev === second.dev && first.ino === second.ino
  );
}

async function openVerifiedRegularFile(path: string, openFile: OpenFile = open) {
  const root = await ensureStoreRoot();
  if (dirname(path) !== root && dirname(dirname(path)) !== root) {
    throw new MockObjectStoreError('INVALID');
  }
  const rootBefore = await lstat(root);
  const canonicalRoot = await realpath(root);
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new MockObjectStoreError('INVALID');
  const actual = await realpath(path);
  const expected = resolve(canonicalRoot, relative(root, path));
  if (!samePath(actual, expected)) throw new MockObjectStoreError('INVALID');
  const noFollow = 'O_NOFOLLOW' in fsConstants ? fsConstants.O_NOFOLLOW : 0;
  const handle = await openFile(path, fsConstants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    const after = await lstat(path);
    const rootAfter = await lstat(root);
    const canonicalRootAfter = await realpath(root);
    if (
      !opened.isFile() ||
      after.isSymbolicLink() ||
      !after.isFile() ||
      !sameFileIdentity(before, opened) ||
      !sameFileIdentity(after, opened) ||
      !sameFileIdentity(rootBefore, rootAfter) ||
      !samePath(canonicalRootAfter, canonicalRoot)
    ) {
      throw new MockObjectStoreError('INVALID');
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function readRegularText(path: string): Promise<string> {
  const handle = await openVerifiedRegularFile(path);
  try {
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

function storeAuxiliaryPath(file: string): string {
  if (!/^\.[a-z0-9.-]+$/.test(file) || file.includes('..')) {
    throw new MockObjectStoreError('INVALID');
  }
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
  readonly state: 'ACTIVE' | 'RELEASING';
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
    Object.keys(owner).sort().join(',') !== 'createdAt,pid,state,token,version' ||
    owner.version !== 1 ||
    typeof owner.pid !== 'number' ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0 ||
    owner.pid > 2_147_483_647 ||
    typeof owner.token !== 'string' ||
    !UuidSchema.safeParse(owner.token).success ||
    typeof owner.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(owner.createdAt)) ||
    (owner.state !== 'ACTIVE' && owner.state !== 'RELEASING')
  ) {
    return undefined;
  }
  return owner as unknown as StoreLockOwner;
}

async function readLockOwner(directory: string): Promise<StoreLockOwner | undefined> {
  try {
    return parseLockOwner(JSON.parse(await readRegularText(lockOwnerPath(directory))));
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

function isRecoverableLockOwner(
  owner: StoreLockOwner,
  liveness: (pid: number) => 'ALIVE' | 'DEAD' | 'UNKNOWN',
): boolean {
  return owner.state === 'RELEASING' || liveness(owner.pid) === 'DEAD';
}

async function tryAcquireStoreLockWith(
  lockPath: string,
  renameDirectory: (source: string, target: string) => Promise<void> = renameDirectoryWithRetry,
): Promise<StoreLockOwner | undefined> {
  const recoveryPath = storeAuxiliaryPath('.store-lock-recovery');
  const recovery = await stat(recoveryPath).catch((error: unknown) => {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  });
  if (recovery) return undefined;
  const owner: StoreLockOwner = {
    version: 1,
    pid: process.pid,
    token: createUuidV7(),
    createdAt: new Date().toISOString(),
    state: 'ACTIVE',
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
      await renameDirectory(candidatePath, lockPath);
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

async function createRecoveryCandidate(): Promise<{
  readonly owner: StoreLockOwner;
  readonly path: string;
}> {
  const owner: StoreLockOwner = {
    version: 1,
    pid: process.pid,
    token: createUuidV7(),
    createdAt: new Date().toISOString(),
    state: 'ACTIVE',
  };
  const path = storeAuxiliaryPath(`.store-lock-recovery-candidate-${owner.token}`);
  await mkdir(path);
  try {
    const handle = await open(lockOwnerPath(path), 'wx');
    try {
      await handle.writeFile(JSON.stringify(owner), 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { owner, path };
  } catch (error) {
    await rm(path, { force: true, recursive: true }).catch(() => undefined);
    throw error;
  }
}

async function recoverDeadRecoveryFence(
  recoveryPath: string,
  liveness: (pid: number) => 'ALIVE' | 'DEAD' | 'UNKNOWN',
): Promise<boolean> {
  const owner = await readLockOwner(recoveryPath);
  if (!owner || !isRecoverableLockOwner(owner, liveness)) return false;
  const quarantinePath = storeAuxiliaryPath(`.store-lock-recovery-quarantine-${owner.token}`);
  try {
    await renameDirectoryWithRetry(recoveryPath, quarantinePath);
    const isolated = await readLockOwner(quarantinePath);
    if (!isolated || isolated.pid !== owner.pid || isolated.token !== owner.token) {
      throw new MockObjectStoreError('LOCK_UNAVAILABLE');
    }
    await rm(quarantinePath, { force: true, recursive: true });
    return true;
  } catch {
    return false;
  }
}

async function recoverDeadStoreLock(
  lockPath: string,
  liveness: (pid: number) => 'ALIVE' | 'DEAD' | 'UNKNOWN' = processLiveness,
): Promise<boolean> {
  const recoverableOwner = await readLockOwner(lockPath);
  if (!recoverableOwner || !isRecoverableLockOwner(recoverableOwner, liveness)) return false;
  const recoveryPath = storeAuxiliaryPath('.store-lock-recovery');
  const candidate = await createRecoveryCandidate();
  let ownsRecovery = false;
  try {
    try {
      await renameDirectoryWithRetry(candidate.path, recoveryPath);
      ownsRecovery = true;
    } catch {
      return false;
    }
    const current = await readLockOwner(lockPath);
    if (
      !current ||
      current.pid !== recoverableOwner.pid ||
      current.token !== recoverableOwner.token ||
      current.state !== recoverableOwner.state ||
      !isRecoverableLockOwner(current, liveness)
    ) {
      return false;
    }
    const quarantinePath = storeAuxiliaryPath(`.store-lock-quarantine-${recoverableOwner.token}`);
    await renameDirectoryWithRetry(lockPath, quarantinePath);
    const isolated = await readLockOwner(quarantinePath);
    if (
      !isolated ||
      isolated.pid !== recoverableOwner.pid ||
      isolated.token !== recoverableOwner.token ||
      isolated.state !== recoverableOwner.state
    ) {
      throw new MockObjectStoreError('LOCK_UNAVAILABLE');
    }
    await rm(quarantinePath, { force: true, recursive: true });
    return true;
  } finally {
    await rm(candidate.path, { force: true, recursive: true }).catch(() => undefined);
    if (ownsRecovery) {
      await releaseOwnedLockDirectory(recoveryPath, candidate.owner, renameDirectoryWithRetry);
    }
  }
}

async function renameDirectoryWithRetry(source: string, target: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      if (!hasErrorCode(error, 'EPERM') && !hasErrorCode(error, 'EBUSY')) throw error;
      if (attempt === 19) throw error;
      await delay(10);
    }
  }
}

async function releaseStoreLockWith(
  lockPath: string,
  owner: StoreLockOwner,
  renameDirectory: (source: string, target: string) => Promise<void> = renameDirectoryWithRetry,
): Promise<void> {
  await releaseOwnedLockDirectory(lockPath, owner, renameDirectory);
}

function lockOwnerTemporaryPath(directory: string, token: string): string {
  if (!UuidSchema.safeParse(token).success) throw new MockObjectStoreError('INVALID');
  const target = resolve(directory, `.owner-${token}.tmp`);
  if (dirname(target) !== directory || basename(target) !== `.owner-${token}.tmp`) {
    throw new MockObjectStoreError('INVALID');
  }
  return target;
}

async function markLockReleasing(
  lockPath: string,
  owner: StoreLockOwner,
  renameFile: (source: string, target: string) => Promise<void>,
): Promise<StoreLockOwner> {
  const releasing = { ...owner, state: 'RELEASING' as const };
  const target = lockOwnerPath(lockPath);
  const temporary = lockOwnerTemporaryPath(lockPath, owner.token);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const current = await readLockOwner(lockPath);
    if (!current || current.pid !== owner.pid || current.token !== owner.token) {
      throw new MockObjectStoreError('LOCK_UNAVAILABLE');
    }
    if (current.state === 'RELEASING') return current;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx');
      await handle.writeFile(JSON.stringify(releasing), 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await renameFile(temporary, target);
      const published = await readLockOwner(lockPath);
      if (
        published?.pid === owner.pid &&
        published.token === owner.token &&
        published.state === 'RELEASING'
      ) {
        return published;
      }
    } catch (error) {
      await handle?.close().catch(() => undefined);
      if (
        error instanceof MockObjectStoreError ||
        (!hasErrorCode(error, 'EPERM') &&
          !hasErrorCode(error, 'EBUSY') &&
          !hasErrorCode(error, 'EEXIST'))
      ) {
        throw error;
      }
    } finally {
      await removeIfPresent(temporary).catch(() => undefined);
    }
    await delay(10);
  }
  throw new MockObjectStoreError('LOCK_UNAVAILABLE');
}

async function releaseOwnedLockDirectory(
  lockPath: string,
  owner: StoreLockOwner,
  renameDirectory: (source: string, target: string) => Promise<void>,
): Promise<void> {
  const current = await readLockOwner(lockPath);
  if (!current || current.pid !== owner.pid || current.token !== owner.token) {
    throw new MockObjectStoreError('LOCK_UNAVAILABLE');
  }
  await markLockReleasing(lockPath, current, renameDirectory);
  const releasePrefix = lockPath.endsWith('.store-lock-recovery')
    ? '.store-lock-recovery-release'
    : '.store-lock-release';
  const releasePath = storeAuxiliaryPath(`${releasePrefix}-${owner.token}`);
  await renameDirectory(lockPath, releasePath);
  await rm(releasePath, { force: true, recursive: true });
}

export interface StoreLockPolicy {
  readonly attempts?: number;
  readonly liveness?: (pid: number) => 'ALIVE' | 'DEAD' | 'UNKNOWN';
  readonly renameDirectory?: (source: string, target: string) => Promise<void>;
}

async function withStoreLock<T>(
  operation: () => Promise<T>,
  policy: StoreLockPolicy = {},
  onActiveReleaseFailure?: () => Promise<void>,
): Promise<T> {
  await ensureStoreRoot();
  const lockPath = storeAuxiliaryPath('.store-lock');
  let owner: StoreLockOwner | undefined;
  const attempts = policy.attempts ?? STORE_LOCK_ATTEMPTS;
  const renameDirectory = policy.renameDirectory ?? renameDirectoryWithRetry;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > STORE_LOCK_ATTEMPTS) {
    throw new MockObjectStoreError('INVALID');
  }
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const recoveryPath = storeAuxiliaryPath('.store-lock-recovery');
    await recoverDeadRecoveryFence(recoveryPath, policy.liveness ?? processLiveness);
    owner = await tryAcquireStoreLockWith(lockPath, renameDirectory);
    if (owner) break;
    if (await recoverDeadStoreLock(lockPath, policy.liveness)) continue;
    await delay(25);
  }
  if (!owner) throw new MockObjectStoreError('LOCK_UNAVAILABLE');
  const operationResult = await operation().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ error, ok: false as const }),
  );
  try {
    await releaseStoreLockWith(lockPath, owner, renameDirectory);
  } catch (error) {
    const retained = await readLockOwner(lockPath).catch(() => undefined);
    if (
      retained?.pid === owner.pid &&
      retained.token === owner.token &&
      retained.state === 'ACTIVE'
    ) {
      await onActiveReleaseFailure?.().catch(() => undefined);
    }
    if (error instanceof MockObjectStoreError) throw error;
    throw new MockObjectStoreError('LOCK_UNAVAILABLE');
  }
  if (!operationResult.ok) throw operationResult.error;
  return operationResult.value;
}

export async function transactMockStoreJson<T>(
  file: string,
  operation: (current: unknown) =>
    | Promise<{
        readonly result: T;
        readonly next?: unknown;
      }>
    | {
        readonly result: T;
        readonly next?: unknown;
      },
): Promise<T> {
  return withStoreLock(async () => {
    const target = storeAuxiliaryPath(file);
    const current = await readRegularText(target).then(
      (text) => JSON.parse(text) as unknown,
      (error: unknown) => {
        if (hasErrorCode(error, 'ENOENT')) return undefined;
        throw error;
      },
    );
    const { result, next } = await operation(current);
    if (next !== undefined) {
      const temporary = storeAuxiliaryPath(`.auxiliary-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, JSON.stringify(next), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
        await rename(temporary, target);
      } catch (error) {
        await removeIfPresent(temporary).catch(() => undefined);
        throw error;
      }
    }
    return result;
  });
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
    'kind',
    'source',
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
    (item.kind !== 'UPLOAD' && item.kind !== 'RESULT') ||
    (item.source !== 'UPLOAD' && item.source !== 'SEED') ||
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
    return parseMetadata(JSON.parse(await readRegularText(objectPath(storageKey, '.json'))));
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

function suppressionPath(ownerId: string, assetId: string): string {
  const digest = createHash('sha256')
    .update(`mock-seed-suppression:v1:${ownerId}:${assetId}`, 'utf8')
    .digest('hex');
  return storeAuxiliaryPath(`.asset-suppression-${digest}.json`);
}

async function isSeedSuppressed(ownerId: string, assetId: string): Promise<boolean> {
  try {
    const value = JSON.parse(await readRegularText(suppressionPath(ownerId, assetId))) as unknown;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new MockObjectStoreError('INVALID');
    }
    const marker = value as Record<string, unknown>;
    if (
      Object.keys(marker).sort().join(',') !== 'assetId,createdAt,ownerId,version' ||
      marker.version !== 1 ||
      marker.ownerId !== ownerId ||
      marker.assetId !== assetId ||
      typeof marker.createdAt !== 'string' ||
      !Number.isFinite(Date.parse(marker.createdAt))
    ) {
      throw new MockObjectStoreError('INVALID');
    }
    return true;
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return false;
    throw error;
  }
}

async function suppressSeed(ownerId: string, assetId: string): Promise<void> {
  if (await isSeedSuppressed(ownerId, assetId)) return;
  const suppressions = (await readdir(storeRoot())).filter((file) =>
    /^\.asset-suppression-[a-f0-9]{64}\.json$/.test(file),
  );
  if (suppressions.length >= MAX_SEED_SUPPRESSIONS) {
    throw new MockObjectStoreError('CAPACITY');
  }
  const target = suppressionPath(ownerId, assetId);
  const temporary = storeAuxiliaryPath(`.asset-suppression-${randomUUID()}.tmp`);
  try {
    await writeFile(
      temporary,
      JSON.stringify({ version: 1, ownerId, assetId, createdAt: new Date().toISOString() }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    await rename(temporary, target);
  } catch (error) {
    await removeIfPresent(temporary).catch(() => undefined);
    throw error;
  }
}

type AssetCommandOperation = 'DELETE' | 'RENAME';

interface AssetCommandRecord {
  readonly version: 1;
  readonly ownerId: string;
  readonly operation: AssetCommandOperation;
  readonly idempotencyKey: string;
  readonly fingerprint: string;
  readonly assetId: string;
  readonly state: 'PENDING' | 'COMPLETE';
  readonly result: AssetListItem | { readonly accepted: true };
  readonly createdAt: string;
  readonly expiresAt: string;
}

function commandStorageKey(
  ownerId: string,
  operation: AssetCommandOperation,
  idempotencyKey: string,
): string {
  return createHash('sha256')
    .update(`mock-asset-command:v1:${ownerId}:${operation}:${idempotencyKey}`, 'utf8')
    .digest('hex');
}

function commandPath(ownerId: string, operation: AssetCommandOperation, idempotencyKey: string) {
  return storeAuxiliaryPath(
    `.asset-command-${commandStorageKey(ownerId, operation, idempotencyKey)}.json`,
  );
}

function parseAssetResult(value: unknown): AssetListItem | { readonly accepted: true } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MockObjectStoreError('INVALID');
  }
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length === 1 && item.accepted === true) return { accepted: true };
  if (
    Object.keys(item).sort().join(',') !== 'createdAt,id,kind,mimeType,name,posterAlt,sizeBytes' ||
    typeof item.id !== 'string' ||
    !UuidSchema.safeParse(item.id).success ||
    (item.kind !== 'UPLOAD' && item.kind !== 'RESULT') ||
    typeof item.name !== 'string' ||
    typeof item.mimeType !== 'string' ||
    typeof item.sizeBytes !== 'string' ||
    !/^\d+$/.test(item.sizeBytes) ||
    typeof item.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    typeof item.posterAlt !== 'string'
  ) {
    throw new MockObjectStoreError('INVALID');
  }
  return item as unknown as AssetListItem;
}

function parseCommand(value: unknown): AssetCommandRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MockObjectStoreError('INVALID');
  }
  const item = value as Record<string, unknown>;
  if (
    Object.keys(item).sort().join(',') !==
      'assetId,createdAt,expiresAt,fingerprint,idempotencyKey,operation,ownerId,result,state,version' ||
    item.version !== 1 ||
    typeof item.ownerId !== 'string' ||
    !UuidSchema.safeParse(item.ownerId).success ||
    (item.operation !== 'DELETE' && item.operation !== 'RENAME') ||
    typeof item.idempotencyKey !== 'string' ||
    !UuidSchema.safeParse(item.idempotencyKey).success ||
    typeof item.fingerprint !== 'string' ||
    !STORAGE_KEY.test(item.fingerprint) ||
    typeof item.assetId !== 'string' ||
    !UuidSchema.safeParse(item.assetId).success ||
    (item.state !== 'PENDING' && item.state !== 'COMPLETE') ||
    typeof item.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(item.createdAt)) ||
    typeof item.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(item.expiresAt))
  ) {
    throw new MockObjectStoreError('INVALID');
  }
  return { ...(item as unknown as AssetCommandRecord), result: parseAssetResult(item.result) };
}

async function readCommand(
  ownerId: string,
  operation: AssetCommandOperation,
  idempotencyKey: string,
): Promise<AssetCommandRecord | undefined> {
  try {
    return parseCommand(
      JSON.parse(await readRegularText(commandPath(ownerId, operation, idempotencyKey))),
    );
  } catch (error) {
    if (hasErrorCode(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function writeCommand(command: AssetCommandRecord): Promise<void> {
  const target = commandPath(command.ownerId, command.operation, command.idempotencyKey);
  const temporary = storeAuxiliaryPath(
    `.asset-command-${commandStorageKey(command.ownerId, command.operation, command.idempotencyKey)}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, JSON.stringify(command), { encoding: 'utf8', flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await removeIfPresent(temporary).catch(() => undefined);
    throw error;
  }
}

async function cleanupCommandsUnlocked(now = Date.now()): Promise<AssetCommandRecord[]> {
  const commands: AssetCommandRecord[] = [];
  for (const file of await readdir(storeRoot())) {
    if (!/^\.asset-command-[a-f0-9]{64}\.json$/.test(file)) continue;
    const target = storeAuxiliaryPath(file);
    try {
      const command = parseCommand(JSON.parse(await readRegularText(target)));
      if (Date.parse(command.expiresAt) <= now) await removeIfPresent(target);
      else commands.push(command);
    } catch {
      await removeIfPresent(target);
    }
  }
  return commands;
}

async function cleanupUnlocked(now = Date.now()): Promise<MockObjectMetadata[]> {
  const root = storeRoot();
  await mkdir(root, { recursive: true });
  await cleanupCommandsUnlocked(now);
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
            : await lstat(objectPath(storageKey, '.bin')).catch(() => undefined);
        if (
          item.state !== 'UPLOADING' &&
          (content?.isSymbolicLink() ||
            !content?.isFile() ||
            BigInt(content.size) !== BigInt(item.sizeBytes))
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
    if (fileStat && now - fileStat.mtimeMs > UPLOAD_RESERVATION_TTL_MS)
      await removeIfPresent(target);
  }
  for (const file of await readdir(root)) {
    const auxiliary =
      /^\.store-lock-(candidate|quarantine|release|recovery-candidate|recovery-quarantine|recovery-release)-([0-9a-f-]+)$/.exec(
        file,
      );
    const kind = auxiliary?.[1];
    const token = auxiliary?.[2];
    if (!kind || !token || !UuidSchema.safeParse(token).success) continue;
    const target = storeAuxiliaryPath(file);
    const fileStat = await stat(target).catch(() => undefined);
    if (!fileStat?.isDirectory() || now - fileStat.mtimeMs <= AUXILIARY_TTL_MS) continue;
    const auxiliaryOwner = await readLockOwner(target);
    if (
      auxiliaryOwner?.token === token &&
      isRecoverableLockOwner(auxiliaryOwner, processLiveness)
    ) {
      await rm(target, { force: true, recursive: true });
    }
  }
  return metadata;
}

function publicAsset(metadata: MockObjectMetadata): AssetListItem {
  return {
    id: metadata.assetId,
    kind: metadata.kind,
    name: metadata.name,
    mimeType: metadata.mimeType,
    sizeBytes: metadata.sizeBytes,
    createdAt: metadata.createdAt,
    posterAlt: `${metadata.name} 素材预览`,
  };
}

function matchesGrant(
  metadata: MockObjectMetadata,
  grant: Omit<VerifiedUploadGrant, 'startExpiresAtMs' | 'recoveryExpiresAtMs'>,
): boolean {
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

async function reserveMockUploadUnlocked(grant: VerifiedUploadGrant): Promise<void> {
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
    expiresAt: new Date(Date.parse(createdAt) + UPLOAD_RESERVATION_TTL_MS).toISOString(),
    state: 'UPLOADING',
    kind: 'UPLOAD',
    source: 'UPLOAD',
  });
}

export async function reserveMockUpload(
  grant: VerifiedUploadGrant,
  lockPolicy: StoreLockPolicy = {},
): Promise<void> {
  await withStoreLock(() => reserveMockUploadUnlocked(grant), lockPolicy);
}

export async function storeMockUpload(
  grant: VerifiedUploadGrant,
  body: ReadableStream<Uint8Array>,
  lockPolicy: StoreLockPolicy = {},
): Promise<string> {
  const reader = body.getReader();
  const contentPath = objectPath(grant.storageKey, '.bin');
  const temporary = resolve(dirname(contentPath), `${grant.storageKey}.${randomUUID()}.partial`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  const hash = createHash('sha256');
  const signature = new Uint8Array(64 * 1_024);
  let signatureLength = 0;
  let actual = 0n;
  const publishState = { content: false };
  try {
    handle = await withStoreLock(
      async () => {
        await reserveMockUploadUnlocked(grant);
        const current = await readMetadata(grant.storageKey);
        if (!current || !matchesGrant(current, grant)) throw new MockObjectStoreError('NOT_FOUND');
        try {
          handle = await open(temporary, 'wx');
          return handle;
        } catch (error) {
          const hasSiblingAttempt = (await readdir(storeRoot())).some(
            (file) => file.startsWith(`${grant.storageKey}.`) && file.endsWith('.partial'),
          );
          if (current.state === 'UPLOADING' && !hasSiblingAttempt) {
            await removeIfPresent(objectPath(grant.storageKey, '.json'));
          }
          throw error;
        }
      },
      lockPolicy,
      async () => {
        await handle?.close().catch(() => undefined);
        await removeIfPresent(temporary).catch(() => undefined);
        const current = await readMetadata(grant.storageKey).catch(() => undefined);
        if (current?.state === 'UPLOADING' && matchesGrant(current, grant)) {
          const hasSiblingAttempt = (await readdir(storeRoot())).some(
            (file) => file.startsWith(`${grant.storageKey}.`) && file.endsWith('.partial'),
          );
          if (!hasSiblingAttempt) await removeIfPresent(objectPath(grant.storageKey, '.json'));
        }
      },
    );
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
        const existingContent = await lstat(contentPath).catch(() => undefined);
        if (
          !existingContent?.isSymbolicLink() &&
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
      await writeMetadata({
        ...current,
        sha256,
        expiresAt: new Date(Date.now() + OBJECT_TTL_MS).toISOString(),
        state: 'STORED',
      });
      return sha256;
    }, lockPolicy);
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    await handle?.close().catch(() => undefined);
    await removeIfPresent(temporary).catch(() => undefined);
    await withStoreLock(async () => {
      const current = await readMetadata(grant.storageKey).catch(() => undefined);
      if (
        current &&
        matchesGrant(current, grant) &&
        (current.state === 'STORED' || current.state === 'AVAILABLE') &&
        current.sha256
      ) {
        return;
      }
      if (publishState.content) await removeIfPresent(contentPath);
      if (current?.state !== 'UPLOADING' || !matchesGrant(current, grant)) return;
      const prefix = `${grant.storageKey}.`;
      const hasSiblingAttempt = (await readdir(storeRoot())).some(
        (file) =>
          file !== basename(temporary) && file.startsWith(prefix) && file.endsWith('.partial'),
      );
      if (!hasSiblingAttempt) await removeIfPresent(objectPath(grant.storageKey, '.json'));
    }).catch(() => undefined);
    throw error;
  }
}

export async function getStoredMockUploadSha(
  grant: VerifiedUploadGrant,
): Promise<string | undefined> {
  // Status recovery is deliberately lock-free: metadata is atomically replaced, and a failed
  // post-publish lock release must not prevent the signed uploader from learning the durable result.
  const metadata = await readMetadata(grant.storageKey);
  if (!metadata || !matchesGrant(metadata, grant)) return undefined;
  if ((metadata.state !== 'STORED' && metadata.state !== 'AVAILABLE') || !metadata.sha256) {
    return undefined;
  }
  const content = await lstat(objectPath(grant.storageKey, '.bin')).catch(() => undefined);
  if (
    content?.isSymbolicLink() ||
    !content?.isFile() ||
    BigInt(content.size) !== BigInt(metadata.sizeBytes)
  )
    return undefined;
  return metadata.sha256;
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
    const stored = await lstat(objectPath(receipt.storageKey, '.bin')).catch(() => undefined);
    if (
      stored?.isSymbolicLink() ||
      !stored?.isFile() ||
      BigInt(stored.size) !== BigInt(receipt.sizeBytes)
    ) {
      throw new MockObjectStoreError('NOT_FOUND');
    }
    if (metadata.state !== 'AVAILABLE') await writeMetadata({ ...metadata, state: 'AVAILABLE' });
    return publicAsset(metadata);
  });
}

export interface MockSeedObject {
  readonly assetId: string;
  readonly kind: 'UPLOAD' | 'RESULT';
  readonly name: string;
  readonly mimeType: string;
  readonly createdAt: string;
  readonly bytes: Uint8Array;
}

export async function ensureMockSeedObjects(
  ownerId: string,
  seeds: readonly MockSeedObject[],
): Promise<void> {
  await withStoreLock(async () => {
    const current = await cleanupUnlocked();
    await cleanupCommandsUnlocked();
    let total = current.reduce((sum, item) => sum + BigInt(item.sizeBytes), 0n);
    let count = current.length;
    for (const seed of seeds) {
      if (
        !UuidSchema.safeParse(seed.assetId).success ||
        !seed.name.trim() ||
        !Number.isFinite(Date.parse(seed.createdAt)) ||
        !matchesMockUploadSignature(
          seed.name,
          seed.mimeType,
          seed.bytes.subarray(0, 64 * 1_024),
          BigInt(seed.bytes.byteLength),
        )
      ) {
        throw new MockObjectStoreError('INVALID');
      }
      if (await isSeedSuppressed(ownerId, seed.assetId)) {
        continue;
      }
      const storageKey = createHash('sha256')
        .update(`mock-object:v1:${ownerId}:${seed.assetId}`, 'utf8')
        .digest('hex');
      if (current.some((item) => item.storageKey === storageKey)) continue;
      const size = BigInt(seed.bytes.byteLength);
      if (count >= MAX_FILES || total + size > MAX_TOTAL_BYTES) {
        throw new MockObjectStoreError('CAPACITY');
      }
      const contentPath = objectPath(storageKey, '.bin');
      const temporary = resolve(dirname(contentPath), `${storageKey}.${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, seed.bytes, { flag: 'wx' });
        await rename(temporary, contentPath);
        await writeMetadata({
          version: STORE_VERSION,
          ownerId,
          assetId: seed.assetId,
          grantId: seed.assetId,
          idempotencyKey: seed.assetId,
          storageKey,
          name: seed.name,
          mimeType: seed.mimeType,
          sizeBytes: String(seed.bytes.byteLength),
          sha256: createHash('sha256').update(seed.bytes).digest('hex'),
          createdAt: seed.createdAt,
          expiresAt: new Date(Date.now() + OBJECT_TTL_MS).toISOString(),
          state: 'AVAILABLE',
          kind: seed.kind,
          source: 'SEED',
        });
        total += size;
        count += 1;
      } catch (error) {
        await removeIfPresent(temporary).catch(() => undefined);
        await removeIfPresent(contentPath).catch(() => undefined);
        await removeIfPresent(objectPath(storageKey, '.json')).catch(() => undefined);
        throw error;
      }
    }
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
  idempotencyKey: string,
): Promise<AssetListItem | undefined> {
  return withStoreLock(async () => {
    const current = await cleanupUnlocked();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ assetId, name, operation: 'RENAME' }), 'utf8')
      .digest('hex');
    const existing = await readCommand(ownerId, 'RENAME', idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.assetId !== assetId) {
        throw new MockObjectStoreError('IDEMPOTENCY_CONFLICT');
      }
      if (existing.state === 'COMPLETE') return existing.result as AssetListItem;
      const pendingAsset = current.find(
        (item) =>
          item.assetId === assetId && item.ownerId === ownerId && item.state === 'AVAILABLE',
      );
      if (pendingAsset && pendingAsset.name !== name) {
        await writeMetadata({ ...pendingAsset, name });
      }
      await writeCommand({ ...existing, state: 'COMPLETE' });
      return existing.result as AssetListItem;
    }
    const commands = await cleanupCommandsUnlocked();
    if (
      commands.some(
        (command) =>
          command.ownerId === ownerId && command.assetId === assetId && command.state === 'PENDING',
      )
    ) {
      throw new MockObjectStoreError('COMMAND_PENDING');
    }
    const metadata = current.find(
      (item) => item.assetId === assetId && item.ownerId === ownerId && item.state === 'AVAILABLE',
    );
    if (!metadata) return undefined;
    const renamed = { ...metadata, name };
    const result = publicAsset(renamed);
    if (commands.length >= MAX_COMMANDS) throw new MockObjectStoreError('CAPACITY');
    const createdAt = new Date().toISOString();
    const command: AssetCommandRecord = {
      version: 1,
      ownerId,
      operation: 'RENAME',
      idempotencyKey,
      fingerprint,
      assetId,
      state: 'PENDING',
      result,
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + COMMAND_TTL_MS).toISOString(),
    };
    await writeCommand(command);
    await writeMetadata(renamed);
    await writeCommand({ ...command, state: 'COMPLETE' });
    return result;
  });
}

export async function deleteMockObject(
  assetId: string,
  ownerId: string,
  idempotencyKey: string,
): Promise<boolean> {
  return withStoreLock(async () => {
    const current = await cleanupUnlocked();
    const fingerprint = createHash('sha256')
      .update(JSON.stringify({ assetId, operation: 'DELETE' }), 'utf8')
      .digest('hex');
    const existing = await readCommand(ownerId, 'DELETE', idempotencyKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint || existing.assetId !== assetId) {
        throw new MockObjectStoreError('IDEMPOTENCY_CONFLICT');
      }
      if (existing.state === 'COMPLETE') return true;
      const pendingAsset = current.find(
        (item) =>
          item.assetId === assetId && item.ownerId === ownerId && item.state === 'AVAILABLE',
      );
      if (pendingAsset) {
        if (pendingAsset.source === 'SEED') {
          await suppressSeed(ownerId, assetId);
        }
        await removeObjectFiles(pendingAsset.storageKey);
      }
      await writeCommand({ ...existing, state: 'COMPLETE' });
      return true;
    }
    const commands = await cleanupCommandsUnlocked();
    if (
      commands.some(
        (command) =>
          command.ownerId === ownerId && command.assetId === assetId && command.state === 'PENDING',
      )
    ) {
      throw new MockObjectStoreError('COMMAND_PENDING');
    }
    const metadata = current.find(
      (item) => item.assetId === assetId && item.ownerId === ownerId && item.state === 'AVAILABLE',
    );
    if (!metadata) return false;
    if (commands.length >= MAX_COMMANDS) throw new MockObjectStoreError('CAPACITY');
    const createdAt = new Date().toISOString();
    const command: AssetCommandRecord = {
      version: 1,
      ownerId,
      operation: 'DELETE',
      idempotencyKey,
      fingerprint,
      assetId,
      state: 'PENDING',
      result: { accepted: true },
      createdAt,
      expiresAt: new Date(Date.parse(createdAt) + COMMAND_TTL_MS).toISOString(),
    };
    await writeCommand(command);
    if (metadata.source === 'SEED') await suppressSeed(ownerId, assetId);
    await removeObjectFiles(metadata.storageKey);
    await writeCommand({ ...command, state: 'COMPLETE' });
    return true;
  });
}

export function mockObjectContentPath(metadata: MockObjectMetadata): string {
  return objectPath(metadata.storageKey, '.bin');
}

export async function openMockObjectContent(
  metadata: MockObjectMetadata,
  policy: { readonly openFile?: OpenFile } = {},
) {
  const path = objectPath(metadata.storageKey, '.bin');
  const handle = await openVerifiedRegularFile(path, policy.openFile);
  const opened = await handle.stat();
  if (!opened.isFile() || BigInt(opened.size) !== BigInt(metadata.sizeBytes)) {
    await handle.close();
    throw new MockObjectStoreError('INVALID');
  }
  return { handle, size: opened.size };
}
