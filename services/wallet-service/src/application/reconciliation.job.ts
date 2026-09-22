import type {
  FinancialControlRepository,
  ReconciliationReport,
} from './financial-control.repository.js';

export class ReconciliationJob {
  constructor(private readonly repository: FinancialControlRepository) {}

  async run(traceId: string): Promise<ReconciliationReport> {
    const mismatches = await this.repository.findReconciliationMismatches();
    return this.repository.recordReconciliation(traceId, mismatches);
  }
}
