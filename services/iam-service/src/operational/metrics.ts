export type IamMetricName =
  | 'iam_login_success_total'
  | 'iam_login_failure_total'
  | 'iam_mfa_failures_total'
  | 'iam_authorization_denials_total'
  | 'iam_pending_cleanup_failures_total'
  | 'iam_pending_sessions_cleaned_total'
  | 'iam_readiness_adapter_stuck_total';

export class IamMetrics {
  private readonly counters = new Map<IamMetricName, number>();
  constructor(
    private readonly activeSessions: () => Promise<number>,
    private readonly pendingCleanupHealthy: () => boolean = () => true,
  ) {
    for (const name of [
      'iam_login_success_total',
      'iam_login_failure_total',
      'iam_mfa_failures_total',
      'iam_authorization_denials_total',
      'iam_pending_cleanup_failures_total',
      'iam_pending_sessions_cleaned_total',
      'iam_readiness_adapter_stuck_total',
    ] as const) this.counters.set(name, 0);
  }
  increment(name: IamMetricName): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }
  add(name: IamMetricName, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw stableError('INVALID_METRIC_INCREMENT');
    this.counters.set(name, (this.counters.get(name) ?? 0) + value);
  }
  async render(): Promise<string> {
    const active = await this.activeSessions().catch(() => 0);
    if (!Number.isSafeInteger(active) || active < 0) throw stableError('INVALID_METRIC_GAUGE');
    const definitions: readonly [IamMetricName, string][] = [
      ['iam_login_success_total', 'Successful completed administrator logins.'],
      ['iam_login_failure_total', 'Failed administrator login attempts.'],
      ['iam_mfa_failures_total', 'Rejected administrator MFA attempts.'],
      ['iam_authorization_denials_total', 'Denied IAM authorization decisions.'],
      ['iam_pending_cleanup_failures_total', 'Failed bounded pending-session cleanup runs.'],
      ['iam_pending_sessions_cleaned_total', 'Expired pending administrator sessions cleaned.'],
      ['iam_readiness_adapter_stuck_total', 'Readiness adapters that did not settle within abort grace.'],
    ];
    const lines = definitions.flatMap(([name, help]) => [
      `# HELP ${name} ${help}`,
      `# TYPE ${name} counter`,
      `${name} ${String(this.counters.get(name) ?? 0)}`,
    ]);
    lines.push(
      '# HELP iam_active_sessions Current non-revoked, non-expired administrator sessions.',
      '# TYPE iam_active_sessions gauge',
      `iam_active_sessions ${String(active)}`,
      '# HELP iam_pending_cleanup_healthy Whether the bounded cleanup worker last completed successfully.',
      '# TYPE iam_pending_cleanup_healthy gauge',
      `iam_pending_cleanup_healthy ${this.pendingCleanupHealthy() ? '1' : '0'}`,
    );
    return `${lines.join('\n')}\n`;
  }
}
function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
