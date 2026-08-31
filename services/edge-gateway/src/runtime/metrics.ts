type MetricLabels = Readonly<Record<string, string>>;

function escaped(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n');
}

function labelSet(labels: MetricLabels): string {
  const values = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}="${escaped(value)}"`)
    .join(',');
  return values.length === 0 ? '' : `{${values}}`;
}

export class GatewayMetrics {
  private readonly requestCount = new Map<string, number>();
  private readonly requestDuration = new Map<string, number>();
  private authDenials = 0;
  private circuitOpen = 0;
  private rateLimitRejections = 0;
  private sseStreams = 0;
  private upstreamTimeouts = 0;

  observeRoute(method: string, route: string, statusCode: number, durationSeconds: number): void {
    const labels = labelSet({
      method,
      route,
      status_class: `${String(Math.floor(statusCode / 100))}xx`,
    });
    this.requestCount.set(labels, (this.requestCount.get(labels) ?? 0) + 1);
    this.requestDuration.set(labels, (this.requestDuration.get(labels) ?? 0) + durationSeconds);
  }

  incrementAuthDenial(): void {
    this.authDenials += 1;
  }
  incrementCircuitOpen(): void {
    this.circuitOpen += 1;
  }
  incrementRateLimitRejection(): void {
    this.rateLimitRejections += 1;
  }
  incrementUpstreamTimeout(): void {
    this.upstreamTimeouts += 1;
  }
  setActiveSseStreams(value: number): void {
    this.sseStreams = Math.max(0, value);
  }

  render(): string {
    const lines = [
      '# HELP gateway_http_requests_total Gateway HTTP requests by normalized route.',
      '# TYPE gateway_http_requests_total counter',
    ];
    for (const [labels, value] of this.requestCount) {
      lines.push(`gateway_http_requests_total${labels} ${String(value)}`);
    }
    lines.push(
      '# HELP gateway_http_request_duration_seconds Gateway route duration.',
      '# TYPE gateway_http_request_duration_seconds summary',
    );
    for (const [labels, value] of this.requestDuration) {
      lines.push(`gateway_http_request_duration_seconds_sum${labels} ${String(value)}`);
      lines.push(
        `gateway_http_request_duration_seconds_count${labels} ${String(this.requestCount.get(labels) ?? 0)}`,
      );
    }
    lines.push(
      '# TYPE gateway_auth_denials_total counter',
      `gateway_auth_denials_total ${String(this.authDenials)}`,
      '# TYPE gateway_rate_limit_rejections_total counter',
      `gateway_rate_limit_rejections_total ${String(this.rateLimitRejections)}`,
      '# TYPE gateway_circuit_open_total counter',
      `gateway_circuit_open_total ${String(this.circuitOpen)}`,
      '# TYPE gateway_upstream_timeouts_total counter',
      `gateway_upstream_timeouts_total ${String(this.upstreamTimeouts)}`,
      '# TYPE gateway_active_sse_streams gauge',
      `gateway_active_sse_streams ${String(this.sseStreams)}`,
    );
    return `${lines.join('\n')}\n`;
  }
}
