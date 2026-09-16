export type AccountKind =
  'USER_AVAILABLE' | 'USER_FROZEN' | 'PLATFORM_LIABILITY' | 'PLATFORM_CONSUMED' | 'ADJUSTMENT';

export interface EntryDraft {
  account: AccountKind;
  ownerId: string;
  delta: bigint;
}

function positive(points: bigint): void {
  if (points <= 0n) {
    throw Object.assign(new Error('INVALID_POINTS'), { code: 'INVALID_POINTS' });
  }
}

export function assertBalanced(entries: readonly EntryDraft[]): void {
  if (entries.length < 2 || entries.reduce((sum, entry) => sum + entry.delta, 0n) !== 0n) {
    throw Object.assign(new Error('UNBALANCED_LEDGER_TRANSACTION'), {
      code: 'UNBALANCED_LEDGER_TRANSACTION',
    });
  }
}

function balanced(entries: EntryDraft[]): EntryDraft[] {
  assertBalanced(entries);
  return entries;
}

export function reserveEntries(userId: string, points: bigint): EntryDraft[] {
  positive(points);
  return balanced([
    { account: 'USER_AVAILABLE', ownerId: userId, delta: -points },
    { account: 'USER_FROZEN', ownerId: userId, delta: points },
  ]);
}

export function creditEntries(userId: string, points: bigint): EntryDraft[] {
  positive(points);
  return balanced([
    { account: 'PLATFORM_LIABILITY', ownerId: 'platform', delta: -points },
    { account: 'USER_AVAILABLE', ownerId: userId, delta: points },
  ]);
}

export function adjustmentEntries(userId: string, signedPoints: bigint): EntryDraft[] {
  if (signedPoints === 0n) {
    throw Object.assign(new Error('INVALID_POINTS'), { code: 'INVALID_POINTS' });
  }
  return balanced([
    { account: 'ADJUSTMENT', ownerId: 'platform', delta: -signedPoints },
    { account: 'USER_AVAILABLE', ownerId: userId, delta: signedPoints },
  ]);
}

export function settleEntries(userId: string, points: bigint): EntryDraft[] {
  positive(points);
  return balanced([
    { account: 'USER_FROZEN', ownerId: userId, delta: -points },
    { account: 'PLATFORM_CONSUMED', ownerId: 'platform', delta: points },
  ]);
}

export function releaseEntries(userId: string, points: bigint): EntryDraft[] {
  positive(points);
  return balanced([
    { account: 'USER_FROZEN', ownerId: userId, delta: -points },
    { account: 'USER_AVAILABLE', ownerId: userId, delta: points },
  ]);
}
