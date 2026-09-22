import { Readable } from 'node:stream';
import type { PaymentGateway, VerifiedPayment } from '../ports/payment-gateway.js';

export class FakePaymentGateway implements PaymentGateway {
  readonly createdOrders: Array<{
    orderNo: string;
    amountMinor: bigint;
    description: string;
    notifyUrl: string;
  }> = [];
  readonly confirmedOrders = new Map<string, VerifiedPayment>();

  createNativeOrder(input: {
    orderNo: string;
    amountMinor: bigint;
    description: string;
    notifyUrl: string;
  }): Promise<{ prepayId: string; expiresAt: Date }> {
    this.createdOrders.push(input);
    return Promise.resolve({
      prepayId: `fake-${input.orderNo}`,
      expiresAt: new Date(Date.now() + 15 * 60_000),
    });
  }

  verifyCallback(): Promise<VerifiedPayment> {
    return Promise.reject(
      Object.assign(new Error('FAKE_CALLBACK_REQUIRES_SIGNED_FIXTURE'), {
        code: 'FAKE_CALLBACK_REQUIRES_SIGNED_FIXTURE',
      }),
    );
  }

  queryOrder(orderNo: string): Promise<VerifiedPayment | undefined> {
    return Promise.resolve(this.confirmedOrders.get(orderNo));
  }

  closeOrder(): Promise<void> {
    return Promise.resolve();
  }

  refund(input: { refundNo: string }): Promise<{ refundId: string }> {
    return Promise.resolve({ refundId: `fake-refund-${input.refundNo}` });
  }

  downloadBill(): Promise<NodeJS.ReadableStream> {
    return Promise.resolve(Readable.from(''));
  }
}

export function createFakePaymentGateway(config: {
  gatewayName: string;
  appEnv: string;
}): FakePaymentGateway {
  if (config.gatewayName !== 'fake') {
    throw Object.assign(new Error('FAKE_PAYMENT_NOT_CONFIGURED'), {
      code: 'FAKE_PAYMENT_NOT_CONFIGURED',
    });
  }
  if (config.appEnv === 'production') {
    throw Object.assign(new Error('FAKE_PAYMENT_FORBIDDEN_IN_PRODUCTION'), {
      code: 'FAKE_PAYMENT_FORBIDDEN_IN_PRODUCTION',
    });
  }
  return new FakePaymentGateway();
}
