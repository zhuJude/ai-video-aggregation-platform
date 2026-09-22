import {
  createDecipheriv,
  createPublicKey,
  createSign,
  createVerify,
  randomBytes,
} from 'node:crypto';
import { Readable } from 'node:stream';
import type { PaymentGateway, VerifiedPayment } from '../ports/payment-gateway.js';

interface WechatSecrets {
  merchantId: string;
  merchantSerial: string;
  privateKeyPem: string;
  apiV3Key: string;
  platformCertificates: ReadonlyMap<string, string>;
  notifyUrl: string;
  now?: () => Date;
  httpClient?: WechatHttpClient;
}

export interface WechatKmsConfig {
  appEnv: string;
  merchantId: string;
  merchantSerial: string;
  privateKeyRef: string;
  apiV3KeyRef: string;
  platformCertificateRefs: ReadonlyMap<string, string>;
  notifyUrl: string;
}

export interface KmsSecretProvider {
  getSecret(reference: string): Promise<string>;
}

interface HttpResponse {
  status: number;
  body: string;
}

interface WechatHttpClient {
  request(input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<HttpResponse>;
}

class FetchWechatHttpClient implements WechatHttpClient {
  async request(input: {
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: string;
  }): Promise<HttpResponse> {
    const response = await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      ...(input.body === undefined ? {} : { body: input.body }),
    });
    return { status: response.status, body: await response.text() };
  }
}

function paymentError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function requireString(value: unknown, code: string): string {
  if (typeof value !== 'string' || value.length === 0) throw paymentError(code);
  return value;
}

function requireRecord(value: unknown, code: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw paymentError(code);
  return value as Record<string, unknown>;
}

function parseJson(value: string, code: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw paymentError(code);
  }
}

function bigintToWechatNumber(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw paymentError('WECHAT_AMOUNT_OUT_OF_RANGE');
  }
  return Number(value);
}

function header(headers: Record<string, string>, name: string): string {
  const value = Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
  return requireString(value, 'WECHAT_CALLBACK_HEADER_MISSING');
}

export function signWechatRequest(input: {
  method: string;
  canonicalUrl: string;
  timestamp: string;
  nonce: string;
  body: string;
  privateKeyPem: string;
}): string {
  const message = `${input.method}\n${input.canonicalUrl}\n${input.timestamp}\n${input.nonce}\n${input.body}\n`;
  return createSign('RSA-SHA256').update(message).end().sign(input.privateKeyPem, 'base64');
}

export function verifyWechatCallback(input: {
  timestamp: string;
  nonce: string;
  rawBody: string;
  signature: string;
  publicKeyPem: string;
}): boolean {
  const message = `${input.timestamp}\n${input.nonce}\n${input.rawBody}\n`;
  return createVerify('RSA-SHA256')
    .update(message)
    .end()
    .verify(input.publicKeyPem, input.signature, 'base64');
}

export function decryptWechatResource(input: {
  apiV3Key: string;
  nonce: string;
  associatedData: string;
  ciphertext: string;
}): string {
  const key = Buffer.from(input.apiV3Key);
  if (key.length !== 32) throw paymentError('WECHAT_API_V3_KEY_INVALID');
  const encrypted = Buffer.from(input.ciphertext, 'base64');
  if (encrypted.length <= 16) throw paymentError('WECHAT_CIPHERTEXT_INVALID');
  const authTag = encrypted.subarray(encrypted.length - 16);
  const data = encrypted.subarray(0, encrypted.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(input.nonce));
  decipher.setAuthTag(authTag);
  decipher.setAAD(Buffer.from(input.associatedData));
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function createNonce(): string {
  return randomBytes(16).toString('hex');
}

export class WechatPayV3Gateway implements PaymentGateway {
  private readonly now: () => Date;
  private readonly httpClient: WechatHttpClient;

  private constructor(private readonly secrets: WechatSecrets) {
    if (Buffer.byteLength(secrets.apiV3Key) !== 32) {
      throw paymentError('WECHAT_API_V3_KEY_INVALID');
    }
    this.now = secrets.now ?? (() => new Date());
    this.httpClient = secrets.httpClient ?? new FetchWechatHttpClient();
  }

  static forTest(secrets: WechatSecrets): WechatPayV3Gateway {
    return new WechatPayV3Gateway(secrets);
  }

  static async fromKms(
    config: WechatKmsConfig,
    kms: KmsSecretProvider,
  ): Promise<WechatPayV3Gateway> {
    if (
      !config.merchantId ||
      !config.merchantSerial ||
      !config.privateKeyRef ||
      !config.apiV3KeyRef ||
      !config.notifyUrl ||
      config.platformCertificateRefs.size === 0
    ) {
      throw paymentError('WECHAT_KMS_CONFIGURATION_REQUIRED');
    }
    const [privateKeyPem, apiV3Key, certificatePairs] = await Promise.all([
      kms.getSecret(config.privateKeyRef),
      kms.getSecret(config.apiV3KeyRef),
      Promise.all(
        [...config.platformCertificateRefs].map(
          async ([serial, reference]) => [serial, await kms.getSecret(reference)] as const,
        ),
      ),
    ]);
    return new WechatPayV3Gateway({
      merchantId: config.merchantId,
      merchantSerial: config.merchantSerial,
      privateKeyPem,
      apiV3Key,
      platformCertificates: new Map(certificatePairs),
      notifyUrl: config.notifyUrl,
    });
  }

  hasUsableCertificate(): boolean {
    return [...this.secrets.platformCertificates.values()].some((certificate) => {
      try {
        createPublicKey(certificate);
        return true;
      } catch {
        return false;
      }
    });
  }

  async createNativeOrder(input: {
    orderNo: string;
    amountMinor: bigint;
    description: string;
    notifyUrl: string;
  }): Promise<{ prepayId: string; expiresAt: Date }> {
    const response = await this.request('POST', '/v3/pay/transactions/native', {
      mchid: this.secrets.merchantId,
      out_trade_no: input.orderNo,
      description: input.description,
      notify_url: input.notifyUrl,
      amount: { total: bigintToWechatNumber(input.amountMinor), currency: 'CNY' },
    });
    return {
      prepayId: requireString(response.code_url, 'WECHAT_PREPAY_ID_MISSING'),
      expiresAt: new Date(this.now().getTime() + 15 * 60_000),
    };
  }

  async verifyCallback(headers: Record<string, string>, rawBody: string): Promise<VerifiedPayment> {
    await Promise.resolve();
    const serial = header(headers, 'wechatpay-serial');
    const publicKeyPem = this.secrets.platformCertificates.get(serial);
    if (!publicKeyPem) throw paymentError('WECHAT_UNKNOWN_CERTIFICATE');
    const timestamp = header(headers, 'wechatpay-timestamp');
    const timestampSeconds = Number(timestamp);
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (!Number.isSafeInteger(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > 300) {
      throw paymentError('WECHAT_CALLBACK_TIMESTAMP_INVALID');
    }
    const nonce = header(headers, 'wechatpay-nonce');
    const signature = header(headers, 'wechatpay-signature');
    if (!verifyWechatCallback({ timestamp, nonce, rawBody, signature, publicKeyPem })) {
      throw paymentError('WECHAT_CALLBACK_SIGNATURE_INVALID');
    }

    const callback = requireRecord(
      parseJson(rawBody, 'WECHAT_CALLBACK_JSON_INVALID'),
      'WECHAT_CALLBACK_JSON_INVALID',
    );
    const resource = requireRecord(callback.resource, 'WECHAT_CALLBACK_RESOURCE_INVALID');
    if (resource.algorithm !== 'AEAD_AES_256_GCM') {
      throw paymentError('WECHAT_CALLBACK_ALGORITHM_INVALID');
    }
    const plaintext = decryptWechatResource({
      apiV3Key: this.secrets.apiV3Key,
      nonce: requireString(resource.nonce, 'WECHAT_CALLBACK_RESOURCE_INVALID'),
      associatedData: typeof resource.associated_data === 'string' ? resource.associated_data : '',
      ciphertext: requireString(resource.ciphertext, 'WECHAT_CALLBACK_RESOURCE_INVALID'),
    });
    return this.parsePayment(plaintext);
  }

  async queryOrder(orderNo: string): Promise<VerifiedPayment | undefined> {
    const path = `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}?mchid=${encodeURIComponent(this.secrets.merchantId)}`;
    const response = await this.request('GET', path);
    if (response.trade_state !== 'SUCCESS') return undefined;
    return this.parsePayment(JSON.stringify(response));
  }

  async closeOrder(orderNo: string): Promise<void> {
    await this.request(
      'POST',
      `/v3/pay/transactions/out-trade-no/${encodeURIComponent(orderNo)}/close`,
      { mchid: this.secrets.merchantId },
      true,
    );
  }

  async refund(input: {
    orderNo: string;
    refundNo: string;
    amountMinor: bigint;
    reason: string;
  }): Promise<{ refundId: string }> {
    const response = await this.request('POST', '/v3/refund/domestic/refunds', {
      out_trade_no: input.orderNo,
      out_refund_no: input.refundNo,
      reason: input.reason,
      amount: {
        refund: bigintToWechatNumber(input.amountMinor),
        total: bigintToWechatNumber(input.amountMinor),
        currency: 'CNY',
      },
    });
    return { refundId: requireString(response.refund_id, 'WECHAT_REFUND_ID_MISSING') };
  }

  async downloadBill(date: string): Promise<NodeJS.ReadableStream> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw paymentError('WECHAT_BILL_DATE_INVALID');
    const response = await this.request('GET', `/v3/bill/tradebill?bill_date=${date}`);
    const downloadUrl = requireString(response.download_url, 'WECHAT_BILL_URL_MISSING');
    const bill = await this.httpClient.request({ method: 'GET', url: downloadUrl, headers: {} });
    if (bill.status < 200 || bill.status >= 300) throw paymentError('WECHAT_BILL_DOWNLOAD_FAILED');
    return Readable.from(bill.body);
  }

  private async request(
    method: string,
    canonicalUrl: string,
    payload?: Record<string, unknown>,
    allowEmpty = false,
  ): Promise<Record<string, unknown>> {
    const body = payload === undefined ? '' : JSON.stringify(payload);
    const timestamp = Math.floor(this.now().getTime() / 1000).toString();
    const nonce = createNonce();
    const signature = signWechatRequest({
      method,
      canonicalUrl,
      timestamp,
      nonce,
      body,
      privateKeyPem: this.secrets.privateKeyPem,
    });
    const response = await this.httpClient.request({
      method,
      url: `https://api.mch.weixin.qq.com${canonicalUrl}`,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `WECHATPAY2-SHA256-RSA2048 mchid="${this.secrets.merchantId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${this.secrets.merchantSerial}",signature="${signature}"`,
      },
      ...(body === '' ? {} : { body }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw paymentError('WECHAT_API_REQUEST_FAILED');
    }
    if (response.body === '' && allowEmpty) return {};
    return requireRecord(
      parseJson(response.body, 'WECHAT_API_RESPONSE_INVALID'),
      'WECHAT_API_RESPONSE_INVALID',
    );
  }

  private parsePayment(plaintext: string): VerifiedPayment {
    const payment = requireRecord(
      parseJson(plaintext, 'WECHAT_PAYMENT_INVALID'),
      'WECHAT_PAYMENT_INVALID',
    );
    if (payment.trade_state !== 'SUCCESS') throw paymentError('WECHAT_PAYMENT_NOT_SUCCESS');
    const amount = requireRecord(payment.amount, 'WECHAT_PAYMENT_AMOUNT_INVALID');
    if (
      amount.currency !== 'CNY' ||
      !Number.isSafeInteger(amount.total) ||
      Number(amount.total) <= 0
    ) {
      throw paymentError('WECHAT_PAYMENT_AMOUNT_INVALID');
    }
    const paidAt = new Date(requireString(payment.success_time, 'WECHAT_PAYMENT_TIME_INVALID'));
    if (Number.isNaN(paidAt.getTime())) throw paymentError('WECHAT_PAYMENT_TIME_INVALID');
    return {
      transactionId: requireString(payment.transaction_id, 'WECHAT_TRANSACTION_ID_MISSING'),
      orderNo: requireString(payment.out_trade_no, 'WECHAT_ORDER_NO_MISSING'),
      merchantId: requireString(payment.mchid, 'WECHAT_MERCHANT_ID_MISSING'),
      amountMinor: BigInt(amount.total as number),
      currency: 'CNY',
      paidAt,
    };
  }
}
