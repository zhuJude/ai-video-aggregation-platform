import {
  DEFAULT_UPSTREAM_DEADLINE_MS,
  SafeHttpRequestError,
  fetchWithDeadline,
  isValidDeadline,
} from './http-deadline';
import { isPointsString, isUtcIso8601Z } from './frozen-scalars';
import { isOutboundRequestContext, type OutboundRequestContext } from './outbound-request-context';
import type {
  OverviewDataset,
  OverviewPort,
  OverviewSourceStatus,
  OverviewView,
} from './overview-view-loader';
import {
  type SafeTelemetryEvent,
  type SafeTelemetryPort,
  createSafeTelemetryEvent,
  defaultSafeTelemetry,
  recordTechnicalFailure,
} from './safe-telemetry';
import { isPhoneFreeBoundedText } from './phone-free-egress';

type OverviewEnvironment = Readonly<{
  apiUrl?: string | undefined;
  kmsIdentityReference?: string | undefined;
}>;

type HttpOverviewPortOptions = Readonly<{
  deadlineMs?: number;
  fetchImpl?: typeof fetch;
  telemetry?: SafeTelemetryPort;
}>;

const requiredMeasures: Readonly<Record<string, readonly string[]>> = {
  finance: [
    'income',
    'provider-cost',
    'gross-margin',
    'gross-margin-rate',
    'average-revenue-per-user',
    'repeat-purchase-rate',
  ],
  operations: ['registrations', 'active-users', 'recharge-points', 'consumption-points'],
  'supplier-risk': ['supplier-balance', 'supplier-failure-rate', 'payment-anomalies', 'service-alerts'],
  tasks: ['task-count', 'success-rate', 'average-generation-duration', 'queue-backlog'],
};
const statusValues = new Set<OverviewSourceStatus>(['READY', 'PARTIAL', 'STALE', 'EMPTY', 'ERROR']);
const pointMeasureIds = new Set(['recharge-points', 'consumption-points', 'supplier-balance']);
const countMeasureIds = new Set(['registrations', 'active-users', 'task-count', 'queue-backlog', 'payment-anomalies', 'service-alerts']);
const moneyMeasureIds = new Set(['income', 'provider-cost', 'average-revenue-per-user']);
const signedMoneyMeasureIds = new Set(['gross-margin']);
const rateMeasureIds = new Set(['success-rate', 'supplier-failure-rate', 'gross-margin-rate', 'repeat-purchase-rate']);
const durationMeasureId = 'average-generation-duration';
const safeText = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const phoneFreeText = (value: unknown): value is string => isPhoneFreeBoundedText(value, 512);

function isCanonicalPercent(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = /^(0|[1-9][0-9]?|100)\.([0-9]{2})%$/u.exec(value);
  if (!match) return false;
  return match[1] !== '100' || match[2] === '00';
}

function malformed(telemetry: SafeTelemetryPort, requestContext: OutboundRequestContext): never {
  throw recordTechnicalFailure(
    telemetry,
    createSafeTelemetryEvent('overview.read', 'MALFORMED_RESPONSE', requestContext),
    new Error('Invalid overview response'),
  );
}

function parseDataset(value: unknown, telemetry: SafeTelemetryPort, requestContext: OutboundRequestContext): OverviewDataset {
  if (!value || typeof value !== 'object') return malformed(telemetry, requestContext);
  const candidate = value as Partial<OverviewDataset>;
  if (!safeText(candidate.id) || !phoneFreeText(candidate.label) || !statusValues.has(candidate.status as OverviewSourceStatus) || !Array.isArray(candidate.measures)) return malformed(telemetry, requestContext);
  if (candidate.status === 'ERROR') {
    if (!phoneFreeText(candidate.reason) || candidate.measures.length !== 0 || candidate.sourceTimestamp !== undefined) return malformed(telemetry, requestContext);
    return { id: candidate.id, label: candidate.label, measures: [], reason: candidate.reason, status: candidate.status };
  }
  if (!isUtcIso8601Z(candidate.sourceTimestamp)) return malformed(telemetry, requestContext);
  if (
    (candidate.warning !== undefined && !phoneFreeText(candidate.warning)) ||
    (candidate.reason !== undefined && !phoneFreeText(candidate.reason))
  ) return malformed(telemetry, requestContext);
  if ((candidate.status === 'PARTIAL' || candidate.status === 'STALE') && !phoneFreeText(candidate.warning)) return malformed(telemetry, requestContext);
  const expected = requiredMeasures[candidate.id];
  if (!expected || candidate.measures.length !== expected.length) return malformed(telemetry, requestContext);
  const measures: OverviewDataset['measures'] = candidate.measures.map((measure) => {
    if (!measure || typeof measure !== 'object') return malformed(telemetry, requestContext);
    const item = measure as Record<string, unknown>;
    if (!safeText(item.id) || !phoneFreeText(item.label)) return malformed(telemetry, requestContext);
    if (moneyMeasureIds.has(item.id) || signedMoneyMeasureIds.has(item.id)) {
      if (!isPointsString(item.minorUnits) || item.currency !== 'CNY' || item.value !== undefined || item.unit !== undefined) return malformed(telemetry, requestContext);
      if (signedMoneyMeasureIds.has(item.id)) {
        if (item.direction !== 'CREDIT' && item.direction !== 'DEBIT') return malformed(telemetry, requestContext);
        return { currency: item.currency, direction: item.direction, id: item.id, label: item.label, minorUnits: item.minorUnits };
      }
      if (item.direction !== undefined) return malformed(telemetry, requestContext);
      return { currency: item.currency, id: item.id, label: item.label, minorUnits: item.minorUnits };
    }
    if (item.id === durationMeasureId) {
      if (!isPointsString(item.value) || item.unit !== 'SECONDS' || item.minorUnits !== undefined || item.currency !== undefined || item.direction !== undefined) return malformed(telemetry, requestContext);
      return { id: durationMeasureId, label: item.label, unit: 'SECONDS', value: item.value };
    }
    if (
      !safeText(item.value) ||
      item.unit !== undefined || item.minorUnits !== undefined || item.currency !== undefined || item.direction !== undefined ||
      ((pointMeasureIds.has(item.id) || countMeasureIds.has(item.id)) && !isPointsString(item.value)) ||
      (rateMeasureIds.has(item.id) && !isCanonicalPercent(item.value))
    ) return malformed(telemetry, requestContext);
    return { id: item.id, label: item.label, value: item.value };
  });
  if (new Set(measures.map((measure) => measure.id)).size !== expected.length || !expected.every((id) => measures.some((measure) => measure.id === id))) return malformed(telemetry, requestContext);
  return {
    id: candidate.id, label: candidate.label, measures, sourceTimestamp: candidate.sourceTimestamp,
    status: candidate.status as OverviewSourceStatus, ...(candidate.warning === undefined ? {} : { warning: candidate.warning }),
  };
}

export function createHttpOverviewPort(
  environment: OverviewEnvironment = { apiUrl: process.env.ADMIN_REPORTING_API_URL, kmsIdentityReference: process.env.ADMIN_REPORTING_KMS_IDENTITY_REF },
  options: HttpOverviewPortOptions = {},
): OverviewPort {
  const telemetry = options.telemetry ?? defaultSafeTelemetry;
  const deadlineMs = options.deadlineMs ?? DEFAULT_UPSTREAM_DEADLINE_MS;
  let baseUrl: URL;
  try {
    if (!environment.apiUrl || !environment.kmsIdentityReference?.trim() || !isValidDeadline(deadlineMs)) throw new Error('invalid config');
    baseUrl = new URL(environment.apiUrl);
    if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password) throw new Error('invalid config');
  } catch (cause) {
    throw recordTechnicalFailure(
      telemetry,
      createSafeTelemetryEvent('overview.config', 'INVALID_CONFIG'),
      new Error('Admin reporting configuration is unavailable', { cause }),
    );
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const kmsIdentityReference = environment.kmsIdentityReference;

  return {
    async getOverview({ requestContext, trustedSessionToken }): Promise<OverviewView> {
      const operation: SafeTelemetryEvent['operation'] = 'overview.read';
      if (!isOutboundRequestContext(requestContext)) {
        throw recordTechnicalFailure(
          telemetry,
          createSafeTelemetryEvent(operation, 'DOWNSTREAM_DENIED'),
          new Error('Trusted admin request context is required'),
        );
      }
      const safeContext: OutboundRequestContext = requestContext;
      if (!trustedSessionToken) {
        throw recordTechnicalFailure(
          telemetry,
          createSafeTelemetryEvent(operation, 'DOWNSTREAM_DENIED', safeContext),
          new Error('Trusted admin session is required'),
        );
      }
      try {
        return await fetchWithDeadline(fetchImpl, new URL('/v1/admin/reporting/overview', baseUrl), {
          cache: 'no-store', headers: { Accept: 'application/json', 'X-Admin-Session-Token': trustedSessionToken, 'X-Correlation-Id': safeContext.correlationId, 'X-Service-Identity-Ref': kmsIdentityReference, 'X-Trace-Id': safeContext.traceId }, method: 'GET',
        }, deadlineMs, async (response, signal) => {
          if (!response.ok) {
            const reason = response.status === 401 || response.status === 403 ? 'DOWNSTREAM_DENIED' : 'UPSTREAM_FAILURE';
            throw recordTechnicalFailure(
              telemetry,
              createSafeTelemetryEvent(operation, reason, safeContext),
              new Error('Overview reporting request failed'),
            );
          }
          let payload: unknown;
          try { payload = await response.json(); } catch (error) { if (signal.aborted) throw error; return malformed(telemetry, safeContext); }
          if (!payload || typeof payload !== 'object' || !Array.isArray((payload as { datasets?: unknown }).datasets)) return malformed(telemetry, safeContext);
          const datasets = (payload as { datasets: unknown[] }).datasets;
          if (datasets.length !== Object.keys(requiredMeasures).length) return malformed(telemetry, safeContext);
          const parsed = datasets.map((dataset) => parseDataset(dataset, telemetry, safeContext));
          if (new Set(parsed.map((dataset) => dataset.id)).size !== parsed.length || Object.keys(requiredMeasures).some((id) => !parsed.some((dataset) => dataset.id === id))) return malformed(telemetry, safeContext);
          return { datasets: parsed };
        });
      } catch (error) {
        if (error instanceof SafeHttpRequestError) {
          throw recordTechnicalFailure(
            telemetry,
            createSafeTelemetryEvent(operation, error.reason, safeContext),
            error,
          );
        }
        throw error;
      }
    },
  };
}
