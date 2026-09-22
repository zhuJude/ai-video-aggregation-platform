import type { RechargePackage } from '../application/payment.repository.js';
import type { RechargePackageProvider } from './prisma-payment.repository.js';
import type { WalletCreditPort } from '../application/payment-settlement.repository.js';
import type { WalletRefundPort } from '../application/refund.service.js';
import type { KmsSecretProvider } from '../adapters/wechat-pay-v3.gateway.js';

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(code);
  return value;
}

async function responseJson(response: Response, code: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(code);
  return requireRecord((await response.json()) as unknown, code);
}

export class HttpRechargePackageProvider implements RechargePackageProvider {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
  ) {}

  async findPackage(packageId: string): Promise<RechargePackage | undefined> {
    const response = await fetch(
      `${this.baseUrl}/internal/recharge-packages/${encodeURIComponent(packageId)}`,
      {
        headers: {
          authorization: `Bearer ${this.internalToken}`,
          'x-internal-service': 'payment-service',
        },
      },
    );
    if (response.status === 404) return undefined;
    const value = await responseJson(response, 'RECHARGE_PACKAGE_LOOKUP_FAILED');
    const amountMinor = requireString(value.amountMinor, 'RECHARGE_PACKAGE_INVALID');
    const points = requireString(value.points, 'RECHARGE_PACKAGE_INVALID');
    if (!/^\d+$/.test(amountMinor) || !/^\d+$/.test(points) || value.currency !== 'CNY') {
      throw new Error('RECHARGE_PACKAGE_INVALID');
    }
    return {
      id: requireString(value.id, 'RECHARGE_PACKAGE_INVALID'),
      title: requireString(value.title, 'RECHARGE_PACKAGE_INVALID'),
      amountMinor: BigInt(amountMinor),
      points: BigInt(points),
      currency: 'CNY',
      active: value.active === true,
    };
  }
}

export class HttpWalletPort implements WalletCreditPort, WalletRefundPort {
  constructor(
    private readonly baseUrl: string,
    private readonly internalToken: string,
  ) {}

  credit(input: {
    userId: string;
    points: bigint;
    businessKey: string;
    traceId: string;
  }): Promise<{ ledgerTransactionId: string }> {
    return this.command('credit', input);
  }

  compensateRefund(input: {
    userId: string;
    points: bigint;
    businessKey: string;
    traceId: string;
  }): Promise<{ ledgerTransactionId: string }> {
    return this.command('refund', input);
  }

  private async command(
    operation: 'credit' | 'refund',
    input: { userId: string; points: bigint; businessKey: string; traceId: string },
  ): Promise<{ ledgerTransactionId: string }> {
    const response = await fetch(`${this.baseUrl}/internal/wallet/${operation}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.internalToken}`,
        'content-type': 'application/json',
        'x-internal-service': 'payment-service',
      },
      body: JSON.stringify({ ...input, points: input.points.toString() }),
    });
    const value = await responseJson(response, 'WALLET_COMMAND_FAILED');
    return {
      ledgerTransactionId: requireString(value.transactionId, 'WALLET_RESPONSE_INVALID'),
    };
  }
}

export class HttpKmsSecretProvider implements KmsSecretProvider {
  constructor(
    private readonly endpoint: string,
    private readonly bearerToken: string,
  ) {}

  async getSecret(reference: string): Promise<string> {
    const response = await fetch(`${this.endpoint}/v1/secrets/${encodeURIComponent(reference)}`, {
      headers: { authorization: `Bearer ${this.bearerToken}` },
    });
    const value = await responseJson(response, 'KMS_SECRET_LOAD_FAILED');
    return requireString(value.value, 'KMS_SECRET_VALUE_INVALID');
  }
}
