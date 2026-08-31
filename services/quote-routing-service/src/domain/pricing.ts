export interface CostInput {
  basePoints: bigint;
  unitPoints: bigint;
  units: bigint;
}

export interface PriceTier {
  upToUnits: bigint | null;
  unitPricePoints: bigint;
}

export interface EffectiveVersion {
  version: number;
  effectiveAt: Date;
}

function invalidPricingInput(): Error & { code: 'INVALID_PRICING_INPUT' } {
  return Object.assign(new Error('INVALID_PRICING_INPUT'), {
    code: 'INVALID_PRICING_INPUT' as const,
  });
}

export function priceWithMargin(costPoints: bigint, marginBasisPoints: number): bigint {
  if (
    costPoints < 0n ||
    !Number.isInteger(marginBasisPoints) ||
    marginBasisPoints < 0
  ) {
    throw invalidPricingInput();
  }
  const numerator = costPoints * BigInt(10_000 + marginBasisPoints);
  return (numerator + 9_999n) / 10_000n;
}

export function calculateCost(input: CostInput): bigint {
  if (input.basePoints < 0n || input.unitPoints < 0n || input.units < 0n) {
    throw invalidPricingInput();
  }
  return input.basePoints + input.unitPoints * input.units;
}

export function priceWithTiers(units: bigint, tiers: readonly PriceTier[]): bigint {
  if (units < 0n || tiers.length === 0) throw invalidPricingInput();
  let previousLimit = 0n;
  let remaining = units;
  let total = 0n;
  for (const [index, tier] of tiers.entries()) {
    if (tier.unitPricePoints < 0n) throw invalidPricingInput();
    if (tier.upToUnits === null) {
      if (index !== tiers.length - 1) throw invalidPricingInput();
      total += remaining * tier.unitPricePoints;
      remaining = 0n;
      break;
    }
    if (tier.upToUnits <= previousLimit) throw invalidPricingInput();
    const tierCapacity = tier.upToUnits - previousLimit;
    const used = remaining < tierCapacity ? remaining : tierCapacity;
    total += used * tier.unitPricePoints;
    remaining -= used;
    previousLimit = tier.upToUnits;
    if (remaining === 0n) break;
  }
  if (remaining > 0n) throw invalidPricingInput();
  return total;
}

export function selectEffectiveVersion<T extends EffectiveVersion>(
  versions: readonly T[],
  at: Date,
): T {
  const selected = versions
    .filter((version) => version.effectiveAt.getTime() <= at.getTime())
    .sort(
      (left, right) =>
        right.effectiveAt.getTime() - left.effectiveAt.getTime() ||
        right.version - left.version,
    )[0];
  if (!selected) {
    throw Object.assign(new Error('PRICING_RULE_NOT_EFFECTIVE'), {
      code: 'PRICING_RULE_NOT_EFFECTIVE',
    });
  }
  return selected;
}
