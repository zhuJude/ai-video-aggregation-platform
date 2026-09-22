export type TaskOperation = 'RETRY_PROVIDER' | 'SWITCH_PROVIDER' | 'CANCEL' | 'REFUND' | 'REPAIR';

export type TaskDetail = Readonly<{
  allowedOperations: readonly TaskOperation[];
  assignedAdminIds: readonly string[];
  attempt: Readonly<{
    acceptance: 'NOT_ACCEPTED' | 'ACCEPTED' | 'AMBIGUOUS';
    circuitState: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
    externalTaskIdMasked: string | null;
    number: number;
    providerName: string;
  }>;
  attemptHistory?: readonly Readonly<{
    acceptance: 'NOT_ACCEPTED' | 'ACCEPTED' | 'AMBIGUOUS';
    at: string;
    number: number;
    outcome: string;
    providerName: string;
  }>[];
  duplicatePurchaseRisk: boolean;
  financial: Readonly<{
    chargedPoints: string;
    costPoints: string;
    frozenPoints: string;
    refundedPoints: string;
  }>;
  id: string;
  ownerAdminId: string | null;
  normalizedProviderResponse?: Readonly<{ code: string; message: string; status: string }>;
  operationPreviews: readonly Readonly<{
    impact: string;
    operation: TaskOperation;
    preflightToken: string;
    purchaseSafety: 'NOT_APPLICABLE' | 'NOT_ACCEPTED' | 'CONFIRMED_NO_CHARGE';
  }>[];
  parameterSnapshot: Readonly<Record<string, unknown>>;
  publicError: string | null;
  queue: Readonly<{ enqueuedAt: string; priority: number; shard: string }> | null;
  rawExchange?: Readonly<{ request: unknown; response: unknown }>;
  sourceUpdatedAt: string;
  status: string;
  timeline: readonly Readonly<{ at: string; code: string; label: string }>[];
  userIdMasked: string;
  version: number;
}>;

export type RoutingSimulation = Readonly<{
  candidates: readonly Readonly<{
    costPoints: string;
    marginBps: number;
    modelCode: string;
    providerName: string;
    salePoints: string;
    score: number;
    scoreExplanation: readonly string[];
    selected: boolean;
  }>[];
  exclusions: readonly Readonly<{ modelCode: string; reason: string }>[];
  requestId: string;
  sourceUpdatedAt: string;
}>;

const POINTS_PATTERN = /^(0|[1-9]\d{0,59})$/;
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|secret|signature|token|api[-_]?key|credential/i;

export function isPoints(value: unknown): value is string {
  return typeof value === 'string' && POINTS_PATTERN.test(value);
}

export function formatPoints(value: string): string {
  if (!isPoints(value)) return '—';
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function calculateMarginBps(costPoints: string, salePoints: string): number | null {
  if (!isPoints(costPoints) || !isPoints(salePoints) || salePoints === '0') return null;
  const cost = BigInt(costPoints);
  const sale = BigInt(salePoints);
  return Number(((sale - cost) * 10_000n) / sale);
}

export function formatBps(value: number): string {
  const sign = value < 0 ? '-' : '';
  const absolute = Math.abs(value);
  return `${sign}${String(Math.floor(absolute / 100))}.${String(absolute % 100).padStart(2, '0')}%`;
}

export function redactRawPayload(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[REDACTED:DEPTH_LIMIT]';
  if (Array.isArray(value))
    return value.slice(0, 200).map((item) => redactRawPayload(item, depth + 1));
  if (
    value &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  ) {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 200)) {
      output[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? '[REDACTED]'
        : redactRawPayload(item, depth + 1);
    }
    return output;
  }
  if (typeof value === 'string') {
    return value
      .replace(/(^|\r?\n)(Authorization\s*:\s*)[^\r\n]*/gi, '$1$2[REDACTED]')
      .replace(/(^|\r?\n)((?:Set-)?Cookie\s*:\s*)[^\r\n]*/gi, '$1$2[REDACTED]')
      .replace(/((?:Basic|Bearer)\s+)[^\s,"']+/gi, '$1[REDACTED]')
      .replace(
        /(^|[?&#;\s])((?:access_token|api[-_]?key|client[-_]?secret|credential|password|passwd|refresh_token|signature|token|x-amz-credential|x-amz-security-token|x-amz-signature)=)[^&#;\s]+/gi,
        '$1$2[REDACTED]',
      )
      .replace(
        /(["'](?:access_token|api[-_]?key|authorization|client[-_]?secret|(?:set-)?cookie|credential|password|passwd|refresh_token|secret|signature|token)["']\s*:\s*["'])[^"']*(["'])/gi,
        '$1[REDACTED]$2',
      );
  }
  return value;
}
