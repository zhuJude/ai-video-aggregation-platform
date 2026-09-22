export type CandidateModelStatus = 'DRAFT' | 'ACTIVE' | 'MAINTENANCE' | 'DISABLED';
export type CandidateHealth = 'HEALTHY' | 'DEGRADED' | 'UNHEALTHY';
export type ExclusionReason =
  | 'CAPABILITY_MISMATCH'
  | 'MODEL_NOT_ACTIVE'
  | 'MAINTENANCE'
  | 'CIRCUIT_OPEN'
  | 'QUOTA_EXHAUSTED'
  | 'PROVIDER_BALANCE_LOW'
  | 'UNHEALTHY'
  | 'MARGIN_BELOW_MINIMUM';

export interface RouteCandidate {
  modelId: string;
  capabilityMatch: boolean;
  status: CandidateModelStatus;
  inMaintenance: boolean;
  circuitOpen: boolean;
  quotaExhausted: boolean;
  providerBalanceLow: boolean;
  health: CandidateHealth;
  costPoints: bigint;
  salePoints: bigint;
  qualityBasisPoints: number;
  latencyMs: number;
  priority: number;
}

export interface RouteWeights {
  quality: number;
  speed: number;
  price: number;
  minimumMarginBps: number;
}

export interface ScoredRouteCandidate {
  modelId: string;
  totalScore: number;
  priority: number;
  marginBasisPoints: number;
  components: {
    quality: number;
    speed: number;
    price: number;
  };
}

export interface RouteSelection {
  selected: ScoredRouteCandidate;
  scored: ScoredRouteCandidate[];
  excluded: Array<{ modelId: string; reason: ExclusionReason }>;
}

function routeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function validateInputs(candidates: readonly RouteCandidate[], weights: RouteWeights): void {
  const weightValues = [weights.quality, weights.speed, weights.price];
  if (
    weightValues.some((weight) => !Number.isInteger(weight) || weight < 0 || weight > 10_000) ||
    weightValues.every((weight) => weight === 0) ||
    !Number.isInteger(weights.minimumMarginBps) ||
    weights.minimumMarginBps < 0
  ) {
    throw routeError('INVALID_ROUTE_WEIGHTS');
  }
  for (const candidate of candidates) {
    if (
      candidate.modelId.length === 0 ||
      candidate.costPoints < 0n ||
      candidate.salePoints < 0n ||
      !Number.isInteger(candidate.qualityBasisPoints) ||
      candidate.qualityBasisPoints < 0 ||
      candidate.qualityBasisPoints > 10_000 ||
      !Number.isInteger(candidate.latencyMs) ||
      candidate.latencyMs < 0 ||
      !Number.isInteger(candidate.priority)
    ) {
      throw routeError('INVALID_ROUTE_CANDIDATE');
    }
  }
}

function calculateMarginBasisPoints(candidate: RouteCandidate): number {
  if (candidate.salePoints === 0n) return candidate.costPoints === 0n ? 10_000 : -1_000_000_000;
  const raw = ((candidate.salePoints - candidate.costPoints) * 10_000n) / candidate.salePoints;
  const clamped = raw < -1_000_000_000n ? -1_000_000_000n : raw > 10_000n ? 10_000n : raw;
  return Number(clamped);
}

function exclusionReason(
  candidate: RouteCandidate,
  minimumMarginBps: number,
): ExclusionReason | undefined {
  if (!candidate.capabilityMatch) return 'CAPABILITY_MISMATCH';
  if (candidate.status !== 'ACTIVE') return 'MODEL_NOT_ACTIVE';
  if (candidate.inMaintenance) return 'MAINTENANCE';
  if (candidate.circuitOpen) return 'CIRCUIT_OPEN';
  if (candidate.quotaExhausted) return 'QUOTA_EXHAUSTED';
  if (candidate.providerBalanceLow) return 'PROVIDER_BALANCE_LOW';
  if (candidate.health === 'UNHEALTHY') return 'UNHEALTHY';
  if (calculateMarginBasisPoints(candidate) < minimumMarginBps) {
    return 'MARGIN_BELOW_MINIMUM';
  }
  return undefined;
}

function inverseNormalize(value: bigint, minimum: bigint, maximum: bigint): number {
  if (minimum === maximum) return 10_000;
  return Number(((maximum - value) * 10_000n) / (maximum - minimum));
}

export function selectRoute(
  candidates: readonly RouteCandidate[],
  weights: RouteWeights,
): RouteSelection {
  validateInputs(candidates, weights);
  const excluded: RouteSelection['excluded'] = [];
  const eligible: RouteCandidate[] = [];
  for (const candidate of candidates) {
    const reason = exclusionReason(candidate, weights.minimumMarginBps);
    if (reason) excluded.push({ modelId: candidate.modelId, reason });
    else eligible.push(candidate);
  }
  if (eligible.length === 0) throw routeError('NO_ELIGIBLE_ROUTE');

  const prices = eligible.map((candidate) => candidate.salePoints);
  const latencies = eligible.map((candidate) => BigInt(candidate.latencyMs));
  const minimumPrice = prices.reduce((left, right) => (left < right ? left : right));
  const maximumPrice = prices.reduce((left, right) => (left > right ? left : right));
  const minimumLatency = latencies.reduce((left, right) => (left < right ? left : right));
  const maximumLatency = latencies.reduce((left, right) => (left > right ? left : right));
  const totalWeight = weights.quality + weights.speed + weights.price;

  const scored = eligible
    .map((candidate): ScoredRouteCandidate => {
      const components = {
        quality: candidate.qualityBasisPoints,
        speed: inverseNormalize(BigInt(candidate.latencyMs), minimumLatency, maximumLatency),
        price: inverseNormalize(candidate.salePoints, minimumPrice, maximumPrice),
      };
      const weighted =
        components.quality * weights.quality +
        components.speed * weights.speed +
        components.price * weights.price;
      return {
        modelId: candidate.modelId,
        totalScore: Math.trunc(weighted / totalWeight),
        priority: candidate.priority,
        marginBasisPoints: calculateMarginBasisPoints(candidate),
        components,
      };
    })
    .sort(
      (left, right) =>
        right.totalScore - left.totalScore ||
        left.priority - right.priority ||
        left.modelId.localeCompare(right.modelId),
    );
  excluded.sort(
    (left, right) => left.modelId.localeCompare(right.modelId) || left.reason.localeCompare(right.reason),
  );
  const selected = scored[0];
  if (!selected) throw routeError('NO_ELIGIBLE_ROUTE');
  return { selected, scored, excluded };
}
