import { createHash } from 'node:crypto';
import {
  selectRoute,
  type RouteCandidate,
  type RouteSelection,
  type RouteWeights,
} from '../domain/route-selector.js';

export type QuoteMode = 'SMART' | 'PROFESSIONAL';

export interface QuoteRequest {
  userId: string;
  mode: QuoteMode;
  requestedModelId?: string;
  allowFailover?: boolean;
  capabilityVersionId: string;
  parameters: Record<string, unknown>;
  candidates: RouteCandidate[];
  weights: RouteWeights;
  pricingRuleVersion: number;
  routingRuleVersion: number;
}

export interface QuoteSnapshot {
  id: string;
  userId: string;
  mode: QuoteMode;
  modelId: string;
  candidateModelIds: string[];
  capabilityVersionId: string;
  quotedPoints: bigint;
  costEstimatePoints: bigint;
  pricingRuleVersion: number;
  routingRuleVersion: number;
  parametersHash: string;
  parametersSnapshot: Record<string, unknown>;
  allowFailover: boolean;
  createdAt: Date;
  expiresAt: Date;
  routeDecision: RouteSelection;
}

export interface QuoteRepository {
  save(quote: QuoteSnapshot): Promise<void>;
  findById(id: string): Promise<QuoteSnapshot | undefined>;
}

function quoteError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw quoteError('INVALID_QUOTE_PARAMETERS');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw quoteError('INVALID_QUOTE_PARAMETERS');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) throw quoteError('INVALID_QUOTE_PARAMETERS');
        return `${JSON.stringify(key)}:${canonicalJson(record[key])}`;
      })
      .join(',')}}`;
  }
  throw quoteError('INVALID_QUOTE_PARAMETERS');
}

export function canonicalParametersHash(parameters: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(parameters), 'utf8').digest('hex');
}

export class InMemoryQuoteRepository implements QuoteRepository {
  private readonly quotes = new Map<string, QuoteSnapshot>();

  get size(): number {
    return this.quotes.size;
  }

  save(quote: QuoteSnapshot): Promise<void> {
    if (this.quotes.has(quote.id)) throw quoteError('QUOTE_ID_CONFLICT');
    this.quotes.set(quote.id, structuredClone(quote));
    return Promise.resolve();
  }

  findById(id: string): Promise<QuoteSnapshot | undefined> {
    const quote = this.quotes.get(id);
    return Promise.resolve(quote ? structuredClone(quote) : undefined);
  }
}

export class QuoteService {
  constructor(
    private readonly repository: QuoteRepository,
    private readonly createId: () => string,
  ) {}

  simulate(input: QuoteRequest): RouteSelection {
    if (input.mode === 'PROFESSIONAL') {
      if (!input.requestedModelId) throw quoteError('PROFESSIONAL_MODEL_REQUIRED');
      const requested = input.candidates.find(
        (candidate) => candidate.modelId === input.requestedModelId,
      );
      if (!requested) throw quoteError('PROFESSIONAL_MODEL_NOT_FOUND');
      return selectRoute([requested], input.weights);
    }
    return selectRoute(input.candidates, input.weights);
  }

  async create(input: QuoteRequest, createdAt = new Date()): Promise<QuoteSnapshot> {
    if (!Number.isInteger(input.pricingRuleVersion) || input.pricingRuleVersion <= 0) {
      throw quoteError('PRICING_RULE_VERSION_INVALID');
    }
    if (!Number.isInteger(input.routingRuleVersion) || input.routingRuleVersion <= 0) {
      throw quoteError('ROUTING_RULE_VERSION_INVALID');
    }
    const routeDecision = this.simulate(input);
    const selectedCandidate = input.candidates.find(
      (candidate) => candidate.modelId === routeDecision.selected.modelId,
    );
    if (!selectedCandidate) throw quoteError('ROUTE_SELECTION_INCONSISTENT');
    const candidateModelIds =
      input.mode === 'PROFESSIONAL'
        ? [selectedCandidate.modelId]
        : input.candidates.map((candidate) => candidate.modelId).sort((a, b) => a.localeCompare(b));
    const quote: QuoteSnapshot = {
      id: this.createId(),
      userId: input.userId,
      mode: input.mode,
      modelId: selectedCandidate.modelId,
      candidateModelIds,
      capabilityVersionId: input.capabilityVersionId,
      quotedPoints: selectedCandidate.salePoints,
      costEstimatePoints: selectedCandidate.costPoints,
      pricingRuleVersion: input.pricingRuleVersion,
      routingRuleVersion: input.routingRuleVersion,
      parametersHash: canonicalParametersHash(input.parameters),
      parametersSnapshot: structuredClone(input.parameters),
      allowFailover: input.mode === 'PROFESSIONAL' ? input.allowFailover === true : true,
      createdAt: new Date(createdAt),
      expiresAt: new Date(createdAt.getTime() + 600_000),
      routeDecision,
    };
    await this.repository.save(quote);
    return structuredClone(quote);
  }

  async get(id: string): Promise<QuoteSnapshot> {
    const quote = await this.repository.findById(id);
    if (!quote) throw quoteError('QUOTE_NOT_FOUND');
    return quote;
  }

  async assertUsable(
    id: string,
    parameters: Record<string, unknown>,
    now = new Date(),
  ): Promise<QuoteSnapshot> {
    const quote = await this.get(id);
    if (canonicalParametersHash(parameters) !== quote.parametersHash) {
      throw quoteError('QUOTE_PARAMETERS_CHANGED');
    }
    if (now.getTime() >= quote.expiresAt.getTime()) throw quoteError('QUOTE_EXPIRED');
    return quote;
  }
}
