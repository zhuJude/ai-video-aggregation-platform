type PaymentCounter = 'callback_failures';
type PaymentGauge = 'reconciliation_differences' | 'refund_backlog';

export class FinanceMetrics {
  private readonly counters = new Map<PaymentCounter, number>([['callback_failures', 0]]);
  private readonly gauges = new Map<PaymentGauge, number>([
    ['reconciliation_differences', 0],
    ['refund_backlog', 0],
  ]);

  constructor(private readonly prefix: 'payment') {}

  increment(name: PaymentCounter, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('METRIC_AMOUNT_INVALID');
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  set(name: PaymentGauge, value: number): void {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('METRIC_VALUE_INVALID');
    this.gauges.set(name, value);
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, value] of this.counters) {
      lines.push(`# TYPE ${this.prefix}_${name}_total counter`);
      lines.push(`${this.prefix}_${name}_total ${String(value)}`);
    }
    for (const [name, value] of this.gauges) {
      lines.push(`# TYPE ${this.prefix}_${name} gauge`);
      lines.push(`${this.prefix}_${name} ${String(value)}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
