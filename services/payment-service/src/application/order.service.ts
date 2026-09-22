import { randomBytes } from 'node:crypto';
import { uuidV7 } from '../domain/uuid-v7.js';
import type { PaymentGateway } from '../ports/payment-gateway.js';
import type { PaymentOrderRecord, PaymentRepository } from './payment.repository.js';

export interface CreateOrderCommand {
  userId: string;
  packageId: string;
  traceId: string;
}

function domainError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function orderNumber(): string {
  return `R${Date.now().toString(36).toUpperCase()}${randomBytes(8).toString('hex').toUpperCase()}`;
}

export class OrderService {
  constructor(
    private readonly repository: PaymentRepository,
    private readonly gateway: PaymentGateway,
    private readonly notifyUrl = 'https://payment.invalid/v1/payments/wechat/callback',
  ) {}

  async create(command: CreateOrderCommand): Promise<PaymentOrderRecord> {
    const rechargePackage = await this.repository.findPackage(command.packageId);
    if (!rechargePackage?.active) throw domainError('RECHARGE_PACKAGE_UNAVAILABLE');
    if (rechargePackage.amountMinor <= 0n || rechargePackage.points <= 0n) {
      throw domainError('RECHARGE_PACKAGE_INVALID');
    }

    const order = await this.repository.createOrderWithSnapshot({
      sourcePackageId: rechargePackage.id,
      packageTitle: rechargePackage.title,
      order: {
        id: uuidV7(),
        orderNo: orderNumber(),
        userId: command.userId,
        amountMinor: rechargePackage.amountMinor,
        points: rechargePackage.points,
        currency: rechargePackage.currency,
        description: rechargePackage.title,
        status: 'PENDING',
        traceId: command.traceId,
      },
    });
    const gatewayOrder = await this.gateway.createNativeOrder({
      orderNo: order.orderNo,
      amountMinor: order.amountMinor,
      description: order.description,
      notifyUrl: this.notifyUrl,
    });
    return this.repository.markGatewayCreated(order.id, gatewayOrder);
  }
}
