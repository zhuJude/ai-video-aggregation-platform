type WalletCounter = 'ledger_postings' | 'serializable_retries';
type WalletGauge = 'blocked_wallets';

export class FinanceMetrics {
  private readonly counters = new Map<WalletCounter, number>([
    ['ledger_postings', 0],
    ['serializable_retries', 0],
  ]);
  private readonly gauges = new Map<WalletGauge, number>([['blocked_wallets', 0]]);

  constructor(private readonly prefix: 'wallet') {}

  increment(name: WalletCounter, amount = 1): void {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('METRIC_AMOUNT_INVALID');
    this.counters.set(name, (this.counters.get(name) ?? 0) + amount);
  }

  set(name: WalletGauge, value: number): void {
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
