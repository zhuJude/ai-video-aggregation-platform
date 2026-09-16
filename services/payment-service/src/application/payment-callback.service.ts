import { createHash } from 'node:crypto';
import type { PaymentGateway, VerifiedPayment } from '../ports/payment-gateway.js';
import type {
  PaymentSettlement,
  PaymentSettlementRepository,
  WalletCreditPort,
} from './payment-settlement.repository.js';

interface PaymentCallbackOptions {
  merchantId: string;
  now?: () => Date;
  staleAfterMs?: number;
  recoveryBatchSize?: number;
}

function bodyHash(rawBody: string): string {
  return createHash('sha256').update(rawBody).digest('hex');
}

export class PaymentCallbackService {
  private readonly now: () => Date;
  private readonly staleAfterMs: number;
  private readonly recoveryBatchSize: number;

  constructor(
    private readonly repository: PaymentSettlementRepository,
    private readonly gateway: PaymentGateway,
    private readonly wallet: WalletCreditPort,
    private readonly options: PaymentCallbackOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.staleAfterMs = options.staleAfterMs ?? 120_000;
    this.recoveryBatchSize = options.recoveryBatchSize ?? 100;
  }

  async handle(headers: Record<string, string>, rawBody: string): Promise<PaymentSettlement> {
    const payment = await this.gateway.verifyCallback(headers, rawBody);
    return this.settle(payment, bodyHash(rawBody), 'CALLBACK');
  }

  async recoverStalePending(): Promise<{ checked: number; settled: number }> {
    const cutoff = new Date(this.now().getTime() - this.staleAfterMs);
    const orderNumbers = await this.repository.findPendingBefore(cutoff, this.recoveryBatchSize);
    let settled = 0;
    for (const orderNo of orderNumbers) {
      const payment = await this.gateway.queryOrder(orderNo);
      if (!payment) continue;
      const result = await this.settle(
        payment,
        bodyHash(`active-query:${payment.transactionId}:${payment.orderNo}`),
        'ACTIVE_QUERY',
      );
      if (result.accepted) settled += 1;
    }
    return { checked: orderNumbers.length, settled };
  }

  private async settle(
    payment: VerifiedPayment,
    rawBodyHash: string,
    source: 'CALLBACK' | 'ACTIVE_QUERY',
  ): Promise<PaymentSettlement> {
    const settlement = await this.repository.acceptPayment({
      callbackId: `${source.toLowerCase()}:${payment.transactionId}`,
      rawBodyHash,
      expectedMerchantId: this.options.merchantId,
      payment,
      source,
    });
    if (settlement.accepted) {
      await this.wallet.credit({
        userId: settlement.userId,
        points: settlement.points,
        businessKey: `payment:${settlement.orderId}:credit`,
        traceId: settlement.traceId,
      });
    }
    return settlement;
  }
}
