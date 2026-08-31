import { z } from 'zod';
import type { QuoteRequest } from '../application/quote.service.js';

const CandidateSchema = z.object({
  modelId: z.string().min(1),
  capabilityMatch: z.boolean(),
  status: z.enum(['DRAFT', 'ACTIVE', 'MAINTENANCE', 'DISABLED']),
  inMaintenance: z.boolean(),
  circuitOpen: z.boolean(),
  quotaExhausted: z.boolean(),
  providerBalanceLow: z.boolean(),
  health: z.enum(['HEALTHY', 'DEGRADED', 'UNHEALTHY']),
  costPoints: z.string().regex(/^\d+$/),
  salePoints: z.string().regex(/^\d+$/),
  qualityBasisPoints: z.int().min(0).max(10_000),
  latencyMs: z.int().nonnegative(),
  priority: z.int(),
});

const QuoteRequestSchema = z.object({
  userId: z.string().min(1),
  mode: z.enum(['SMART', 'PROFESSIONAL']),
  requestedModelId: z.string().min(1).optional(),
  allowFailover: z.boolean().optional(),
  capabilityVersionId: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  candidates: z.array(CandidateSchema).min(1),
  weights: z.object({
    quality: z.int().min(0).max(10_000),
    speed: z.int().min(0).max(10_000),
    price: z.int().min(0).max(10_000),
    minimumMarginBps: z.int().nonnegative(),
  }),
  pricingRuleVersion: z.int().positive(),
  routingRuleVersion: z.int().positive(),
});

export function parseQuoteRequest(body: unknown): QuoteRequest {
  const parsed = QuoteRequestSchema.parse(body);
  const { requestedModelId, allowFailover, ...required } = parsed;
  return {
    ...required,
    ...(requestedModelId === undefined ? {} : { requestedModelId }),
    ...(allowFailover === undefined ? {} : { allowFailover }),
    candidates: parsed.candidates.map((candidate) => ({
      ...candidate,
      costPoints: BigInt(candidate.costPoints),
      salePoints: BigInt(candidate.salePoints),
    })),
  };
}
