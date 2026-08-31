export type SafeTelemetryEvent = Readonly<{
  operation:
    | 'iam.config'
    | 'iam.password.begin'
    | 'iam.totp.verify'
    | 'login.action'
    | 'login.config'
    | 'login.password'
    | 'login.totp'
    | 'operations.config'
    | 'operations.scope.read'
    | 'operations.user.refresh';
  reason:
    | 'ACTION_FAILURE'
    | 'CHALLENGE_INVALID'
    | 'DOWNSTREAM_DENIED'
    | 'INVALID_CONFIG'
    | 'MALFORMED_RESPONSE'
    | 'NETWORK_FAILURE'
    | 'TIMEOUT'
    | 'UPSTREAM_FAILURE';
}>;

export interface SafeTelemetryPort {
  record(event: SafeTelemetryEvent): void;
}

export const defaultSafeTelemetry: SafeTelemetryPort = Object.freeze({
  record(event: SafeTelemetryEvent) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn('[admin-web-security]', JSON.stringify(event));
    }
  },
});

export function recordSafeTelemetry(
  telemetry: SafeTelemetryPort,
  event: SafeTelemetryEvent,
): void {
  try {
    telemetry.record(event);
  } catch {
    // Observability failures must not change authentication or authorization.
  }
}
