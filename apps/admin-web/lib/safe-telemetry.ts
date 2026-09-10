import {
  createOutboundRequestContext,
  isOutboundRequestContext,
  type OutboundRequestContext,
} from './outbound-request-context';

export type SafeTelemetryOperation =
  | 'iam.config'
  | 'iam.password.begin'
  | 'iam.totp.verify'
  | 'login.action'
  | 'login.config'
  | 'login.password'
  | 'login.totp'
  | 'operations.config'
  | 'operations.user.directory-search'
  | 'operations.user.exact-phone-lookup'
  | 'operations.user.detail-read'
  | 'operations.scope.read'
  | 'operations.user.csv-export'
  | 'operations.user.wallet-adjustment-request'
  | 'operations.user.wallet-adjustment-preview'
  | 'operations.user.eligible-approvers'
  | 'operations.user.status-change'
  | 'operations.provider.directory-read'
  | 'operations.provider.detail-read'
  | 'operations.provider.config'
  | 'operations.provider.metadata-write'
  | 'operations.provider.command'
  | 'operations.finance.approval'
  | 'operations.finance.compensation-request'
  | 'operations.finance.invoice-detail-read'
  | 'operations.finance.invoice-transition'
  | 'operations.finance.invoices-read'
  | 'operations.finance.ledger-read'
  | 'operations.finance.orders-read'
  | 'operations.finance.order-detail-read'
  | 'operations.finance.order-operation'
  | 'operations.finance.reconciliation-case-read'
  | 'operations.finance.reconciliation-read'
  | 'catalog.config'
  | 'catalog.model.directory-read'
  | 'catalog.model.capability-read'
  | 'catalog.model.capability-create_draft'
  | 'catalog.model.capability-validate'
  | 'catalog.model.capability-save'
  | 'catalog.model.capability-publish'
  | 'catalog.model.capability-rollback'
  | 'overview.config'
  | 'overview.read';

export type SafeTelemetryReason =
  | 'ACTION_FAILURE'
  | 'CHALLENGE_INVALID'
  | 'DOWNSTREAM_DENIED'
  | 'INVALID_CONFIG'
  | 'MALFORMED_RESPONSE'
  | 'NETWORK_FAILURE'
  | 'TIMEOUT'
  | 'UPSTREAM_FAILURE';

declare const safeTelemetryEventBrand: unique symbol;

export type SafeTelemetryEvent = Readonly<{
  correlationId: string;
  operation: SafeTelemetryOperation;
  reason: SafeTelemetryReason;
  traceId: string;
  [safeTelemetryEventBrand]: true;
}>;

export interface SafeTelemetryPort {
  record(event: SafeTelemetryEvent): void;
}

const operationValues = new Set<SafeTelemetryOperation>([
  'iam.config',
  'iam.password.begin',
  'iam.totp.verify',
  'login.action',
  'login.config',
  'login.password',
  'login.totp',
  'operations.config',
  'operations.user.directory-search',
  'operations.user.exact-phone-lookup',
  'operations.user.detail-read',
  'operations.scope.read',
  'operations.user.csv-export',
  'operations.user.wallet-adjustment-request',
  'operations.user.wallet-adjustment-preview',
  'operations.user.eligible-approvers',
  'operations.user.status-change',
  'overview.config',
  'overview.read',
  'operations.provider.directory-read',
  'operations.provider.detail-read',
  'operations.provider.config',
  'operations.provider.metadata-write',
  'operations.provider.command',
  'operations.finance.approval',
  'operations.finance.compensation-request',
  'operations.finance.invoice-detail-read',
  'operations.finance.invoice-transition',
  'operations.finance.invoices-read',
  'operations.finance.ledger-read',
  'operations.finance.orders-read',
  'operations.finance.order-detail-read',
  'operations.finance.order-operation',
  'operations.finance.reconciliation-case-read',
  'operations.finance.reconciliation-read',
  'catalog.config',
  'catalog.model.directory-read',
  'catalog.model.capability-read',
  'catalog.model.capability-create_draft',
  'catalog.model.capability-validate',
  'catalog.model.capability-save',
  'catalog.model.capability-publish',
  'catalog.model.capability-rollback',
]);
const reasonValues = new Set<SafeTelemetryReason>([
  'ACTION_FAILURE',
  'CHALLENGE_INVALID',
  'DOWNSTREAM_DENIED',
  'INVALID_CONFIG',
  'MALFORMED_RESPONSE',
  'NETWORK_FAILURE',
  'TIMEOUT',
  'UPSTREAM_FAILURE',
]);
const issuedSafeTelemetryEvents = new WeakSet<object>();
const recordedTechnicalFailures = new WeakSet<Error>();
const MAX_RECORDED_CAUSE_DEPTH = 8;

function isSafeTelemetryEvent(value: unknown): value is SafeTelemetryEvent {
  return Boolean(value && typeof value === 'object' && issuedSafeTelemetryEvents.has(value));
}

function safeErrorCause(error: Error): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

export function createSafeTelemetryEvent(
  operation: SafeTelemetryOperation,
  reason: SafeTelemetryReason,
  requestContext: OutboundRequestContext = createOutboundRequestContext(),
): SafeTelemetryEvent {
  if (!operationValues.has(operation) || !reasonValues.has(reason)) {
    throw new Error('Invalid safe telemetry event');
  }
  if (!isOutboundRequestContext(requestContext)) {
    throw new Error('Invalid safe telemetry event');
  }
  const event = Object.freeze({
    correlationId: requestContext.correlationId,
    operation,
    reason,
    traceId: requestContext.traceId,
  });
  issuedSafeTelemetryEvents.add(event);
  return event as SafeTelemetryEvent;
}

export const defaultSafeTelemetry: SafeTelemetryPort = Object.freeze({
  record(event: SafeTelemetryEvent) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[admin-web-security]', JSON.stringify(event));
    }
  },
});

export function recordSafeTelemetry(telemetry: SafeTelemetryPort, event: SafeTelemetryEvent): void {
  if (!isSafeTelemetryEvent(event)) throw new Error('Invalid safe telemetry event');
  try {
    telemetry.record(event);
  } catch {
    // Observability sink failures must not change authentication or authorization.
  }
}

export function recordTechnicalFailure<E extends Error>(
  telemetry: SafeTelemetryPort,
  event: SafeTelemetryEvent,
  error: E,
): E {
  recordSafeTelemetry(telemetry, event);
  recordedTechnicalFailures.add(error);
  return error;
}

export function consumeTechnicalFailure(error: unknown): boolean {
  const visited = new Set<Error>();
  let current = error;

  for (let depth = 0; depth < MAX_RECORDED_CAUSE_DEPTH; depth += 1) {
    if (!(current instanceof Error) || visited.has(current)) return false;
    visited.add(current);
    if (recordedTechnicalFailures.delete(current)) return true;
    current = safeErrorCause(current);
  }

  return false;
}
