import type { QuoteSchema } from '@repo/contracts/routing';
import type { LedgerCommandSchema } from '@repo/contracts/wallet';
import type { UuidV7Source } from '../domain/uuid-v7.js';

export type Quote = ReturnType<typeof QuoteSchema.parse>;
export type LedgerCommand = ReturnType<typeof LedgerCommandSchema.parse>;

export interface QuoteRoute {
  readonly quote: Quote;
  readonly capabilitySnapshot: unknown;
  readonly pricingSnapshot: unknown;
}

export interface RoutingQuotePort {
  getQuote(quoteId: string): Promise<QuoteRoute | null>;
}

export interface WalletLedgerPort {
  reserve(command: LedgerCommand): Promise<void>;
  release(command: LedgerCommand): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export type IdGenerator = UuidV7Source;

export type Sleep = (milliseconds: number) => Promise<void>;
