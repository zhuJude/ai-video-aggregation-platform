export type IdentityMetricName =
  | 'identity_login_success_total'
  | 'identity_login_failure_total'
  | 'identity_sms_rate_limit_rejections_total'
  | 'identity_readiness_adapter_stuck_total';

export class IdentityMetrics {
  private readonly counters = new Map<IdentityMetricName, number>();
  constructor(private readonly activeSessions: () => Promise<number>) {
    for (const name of [
      'identity_login_success_total',
      'identity_login_failure_total',
      'identity_sms_rate_limit_rejections_total',
      'identity_readiness_adapter_stuck_total',
    ] as const)
      this.counters.set(name, 0);
  }

  increment(name: IdentityMetricName): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  async render(): Promise<string> {
    const active = await this.activeSessions().catch(() => 0);
    if (!Number.isSafeInteger(active) || active < 0) throw stableError('INVALID_METRIC_GAUGE');
    const lines = [
      '# HELP identity_login_success_total Successful completed user logins.',
      '# TYPE identity_login_success_total counter',
      `identity_login_success_total ${String(this.counters.get('identity_login_success_total') ?? 0)}`,
      '# HELP identity_login_failure_total Failed user login attempts.',
      '# TYPE identity_login_failure_total counter',
      `identity_login_failure_total ${String(this.counters.get('identity_login_failure_total') ?? 0)}`,
      '# HELP identity_sms_rate_limit_rejections_total SMS challenges rejected by rate limits or attempt locks.',
      '# TYPE identity_sms_rate_limit_rejections_total counter',
      `identity_sms_rate_limit_rejections_total ${String(this.counters.get('identity_sms_rate_limit_rejections_total') ?? 0)}`,
      '# HELP identity_readiness_adapter_stuck_total Readiness adapters that did not settle within abort grace.',
      '# TYPE identity_readiness_adapter_stuck_total counter',
      `identity_readiness_adapter_stuck_total ${String(this.counters.get('identity_readiness_adapter_stuck_total') ?? 0)}`,
      '# HELP identity_active_sessions Current non-revoked, non-expired sessions.',
      '# TYPE identity_active_sessions gauge',
      `identity_active_sessions ${String(active)}`,
    ];
    return `${lines.join('\n')}\n`;
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
