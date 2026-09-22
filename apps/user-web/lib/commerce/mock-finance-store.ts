import 'server-only';

import { createHash } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';

import { isUuidV7 } from '../tasks/identifiers';
import {
  parseInvoiceCandidatePage,
  parseOrderCreateResult,
  parseOrderPage,
  parseWalletPage,
} from './runtime';
import { transactMockStoreJson } from './mock-object-store';
import type {
  InvoiceHistoryItem,
  LedgerTransaction,
  RechargeOrderView,
  WalletBalanceView,
} from './types';

const FINANCE_VERSION = 1;
const COMMAND_TTL_MS = 24 * 60 * 60_000;
const MAX_COMMANDS = 10_000;

export interface MockFinanceState {
  readonly version: 1;
  readonly ownerId: string;
  readonly balance: WalletBalanceView;
  readonly ledger: readonly LedgerTransaction[];
  readonly orders: readonly RechargeOrderView[];
  readonly invoices: readonly InvoiceHistoryItem[];
  readonly invoicedOrderIds: readonly string[];
  readonly commands: readonly MockFinanceCommand[];
  readonly commercial?: unknown;
}

interface MockFinanceCommand {
  readonly key: string;
  readonly fingerprint: string;
  readonly kind: 'ORDER' | 'INVOICE';
  readonly result: unknown;
  readonly expiresAt: string;
}

export interface MutableMockFinanceState {
  balance: WalletBalanceView;
  ledger: LedgerTransaction[];
  orders: RechargeOrderView[];
  invoices: InvoiceHistoryItem[];
  invoicedOrderIds: string[];
  commercial?: unknown;
}

export class MockFinanceStoreError extends Error {
  readonly outcome = 'DEFINITIVE_FAILURE' as const;

  constructor(readonly code: 'CAPACITY' | 'IDEMPOTENCY_CONFLICT' | 'INVALID') {
    super(`MOCK_FINANCE_${code}`);
  }
}

function exact(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new MockFinanceStoreError('INVALID');
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MockFinanceStoreError('INVALID');
  }
  return value as Record<string, unknown>;
}

function parseInvoiceResult(value: unknown): { readonly id: string; readonly status: 'SUBMITTED' } {
  const result = record(value);
  exact(result, ['id', 'status']);
  if (!isUuidV7(result.id) || result.status !== 'SUBMITTED') {
    throw new MockFinanceStoreError('INVALID');
  }
  return { id: result.id, status: result.status };
}

function parseCommand(value: unknown): MockFinanceCommand {
  const command = record(value);
  exact(command, ['key', 'fingerprint', 'kind', 'result', 'expiresAt']);
  if (
    !isUuidV7(command.key) ||
    typeof command.fingerprint !== 'string' ||
    command.fingerprint.length < 1 ||
    command.fingerprint.length > 4_096 ||
    (command.kind !== 'ORDER' && command.kind !== 'INVOICE') ||
    typeof command.expiresAt !== 'string' ||
    !Number.isFinite(Date.parse(command.expiresAt))
  ) {
    throw new MockFinanceStoreError('INVALID');
  }
  return {
    key: command.key,
    fingerprint: command.fingerprint,
    kind: command.kind,
    result:
      command.kind === 'ORDER'
        ? parseOrderCreateResult(command.result)
        : parseInvoiceResult(command.result),
    expiresAt: command.expiresAt,
  };
}

function parseState(value: unknown, expectedOwnerId: string): MockFinanceState {
  const state = record(value);
  exact(state, [
    'version',
    'ownerId',
    'balance',
    'ledger',
    'orders',
    'invoices',
    'invoicedOrderIds',
    'commands',
    ...(Object.prototype.hasOwnProperty.call(state, 'commercial') ? ['commercial'] : []),
  ]);
  if (
    state.version !== FINANCE_VERSION ||
    state.ownerId !== expectedOwnerId ||
    !UuidSchema.safeParse(state.ownerId).success ||
    !Array.isArray(state.invoicedOrderIds) ||
    !Array.isArray(state.commands)
  ) {
    throw new MockFinanceStoreError('INVALID');
  }
  const wallet = parseWalletPage({
    balance: state.balance,
    transactions: state.ledger,
    pageInfo: {},
  });
  const orderPage = parseOrderPage({
    packages: [],
    customAmount: { minMinor: '100', maxMinor: '500000', stepMinor: '100' },
    items: state.orders,
    pageInfo: {},
  });
  const invoicePage = parseInvoiceCandidatePage({ items: [], history: state.invoices });
  const invoicedOrderIds = state.invoicedOrderIds.map((value) => {
    if (typeof value !== 'string' || !UuidSchema.safeParse(value).success) {
      throw new MockFinanceStoreError('INVALID');
    }
    return value;
  });
  if (new Set(invoicedOrderIds).size !== invoicedOrderIds.length) {
    throw new MockFinanceStoreError('INVALID');
  }
  const commands = state.commands.map(parseCommand);
  if (new Set(commands.map((command) => command.key)).size !== commands.length) {
    throw new MockFinanceStoreError('INVALID');
  }
  return {
    version: FINANCE_VERSION,
    ownerId: expectedOwnerId,
    balance: wallet.balance,
    ledger: wallet.transactions,
    orders: orderPage.items,
    invoices: invoicePage.history,
    invoicedOrderIds,
    commands,
    ...(state.commercial === undefined ? {} : { commercial: structuredClone(state.commercial) }),
  };
}

function fileName(ownerId: string): string {
  if (!UuidSchema.safeParse(ownerId).success) throw new MockFinanceStoreError('INVALID');
  // v2 keys finance fixtures by the stable mock subject rather than the mutable phone-derived id.
  const digest = createHash('sha256').update(`mock-finance:v2:${ownerId}`).digest('hex');
  return `.finance-${digest}.json`;
}

function cleanedCommands(
  commands: readonly MockFinanceCommand[],
  now: number,
): MockFinanceCommand[] {
  return commands.filter((command) => Date.parse(command.expiresAt) > now);
}

function serializableState(
  ownerId: string,
  business: MutableMockFinanceState,
  commands: readonly MockFinanceCommand[],
): MockFinanceState {
  return parseState(
    {
      version: FINANCE_VERSION,
      ownerId,
      balance: business.balance,
      ledger: business.ledger,
      orders: business.orders,
      invoices: business.invoices,
      invoicedOrderIds: business.invoicedOrderIds,
      commands,
      ...(business.commercial === undefined ? {} : { commercial: business.commercial }),
    },
    ownerId,
  );
}

export async function readMockFinanceState(
  ownerId: string,
  seed: () => MockFinanceState,
): Promise<MockFinanceState> {
  const now = Date.now();
  return transactMockStoreJson(fileName(ownerId), (current) => {
    const state = parseState(current ?? seed(), ownerId);
    const commands = cleanedCommands(state.commands, now);
    const next =
      commands.length === state.commands.length
        ? current === undefined
          ? state
          : undefined
        : {
            ...state,
            commands,
          };
    return { result: next ? parseState(next, ownerId) : state, ...(next ? { next } : {}) };
  });
}

export async function runMockFinanceCommand<T>(
  ownerId: string,
  seed: () => MockFinanceState,
  request: {
    readonly key: string;
    readonly fingerprint: string;
    readonly kind: 'ORDER' | 'INVOICE';
  },
  mutate: (state: MutableMockFinanceState) => T,
): Promise<T> {
  if (!isUuidV7(request.key)) throw new MockFinanceStoreError('INVALID');
  const now = Date.now();
  return transactMockStoreJson(fileName(ownerId), (current) => {
    const state = parseState(current ?? seed(), ownerId);
    const commands = cleanedCommands(state.commands, now);
    const existing = commands.find((command) => command.key === request.key);
    if (existing) {
      if (existing.fingerprint !== request.fingerprint || existing.kind !== request.kind) {
        throw new MockFinanceStoreError('IDEMPOTENCY_CONFLICT');
      }
      return { result: structuredClone(existing.result) as T };
    }
    if (commands.length >= MAX_COMMANDS) throw new MockFinanceStoreError('CAPACITY');
    const business: MutableMockFinanceState = {
      balance: structuredClone(state.balance),
      ledger: [...structuredClone(state.ledger)],
      orders: [...structuredClone(state.orders)],
      invoices: [...structuredClone(state.invoices)],
      invoicedOrderIds: [...state.invoicedOrderIds],
      ...(state.commercial === undefined ? {} : { commercial: structuredClone(state.commercial) }),
    };
    const result = mutate(business);
    const next = serializableState(ownerId, business, [
      ...commands,
      {
        key: request.key,
        fingerprint: request.fingerprint,
        kind: request.kind,
        result: structuredClone(result),
        expiresAt: new Date(now + COMMAND_TTL_MS).toISOString(),
      },
    ]);
    return { result, next };
  });
}

/**
 * Runs generation state and wallet mutations under the same durable object-store lock and
 * atomic JSON replacement as recharge/invoice commands. The commercial payload is parsed by
 * its owning module; this store only preserves the boundary without coupling finance to Studio.
 */
export async function runMockFinanceTransaction<T>(
  ownerId: string,
  seed: () => MockFinanceState,
  mutate: (state: MutableMockFinanceState) => T,
): Promise<T> {
  return transactMockStoreJson(fileName(ownerId), (current) => {
    const state = parseState(current ?? seed(), ownerId);
    const business: MutableMockFinanceState = {
      balance: structuredClone(state.balance),
      ledger: [...structuredClone(state.ledger)],
      orders: [...structuredClone(state.orders)],
      invoices: [...structuredClone(state.invoices)],
      invoicedOrderIds: [...state.invoicedOrderIds],
      ...(state.commercial === undefined ? {} : { commercial: structuredClone(state.commercial) }),
    };
    const result = mutate(business);
    const next = serializableState(ownerId, business, state.commands);
    return { result, next };
  });
}
