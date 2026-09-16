import { createCipheriv, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  WechatPayV3Gateway,
  decryptWechatResource,
  signWechatRequest,
  verifyWechatCallback,
} from '../src/adapters/wechat-pay-v3.gateway.js';
import {
  FakePaymentGateway,
  createFakePaymentGateway,
} from '../src/adapters/fake-payment.gateway.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function encryptResource(apiV3Key: string, plaintext: string) {
  const nonce = randomBytes(6).toString('hex');
  const associatedData = 'payment';
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(apiV3Key), Buffer.from(nonce));
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    nonce,
    associatedData,
    ciphertext: Buffer.concat([encrypted, cipher.getAuthTag()]).toString('base64'),
  };
}

describe('WeChat Pay API v3 cryptography', () => {
  it('signs canonical requests and rejects a mutated callback raw body', () => {
    const signature = signWechatRequest({
      method: 'POST',
      canonicalUrl: '/v3/pay/transactions/native',
      timestamp: '1788148800',
      nonce: 'nonce',
      body: '{"amount":{"total":100}}',
      privateKeyPem,
    });
    expect(signature).toMatch(/^[A-Za-z0-9+/]+=*$/);

    const rawBody = '{"id":"callback-1"}';
    const callbackSignature = createSign('RSA-SHA256')
      .update(`1788148800\nnonce\n${rawBody}\n`)
      .end()
      .sign(privateKeyPem, 'base64');
    expect(
      verifyWechatCallback({
        timestamp: '1788148800',
        nonce: 'nonce',
        rawBody,
        signature: callbackSignature,
        publicKeyPem,
      }),
    ).toBe(true);
    expect(
      verifyWechatCallback({
        timestamp: '1788148800',
        nonce: 'nonce',
        rawBody: `${rawBody} `,
        signature: callbackSignature,
        publicKeyPem,
      }),
    ).toBe(false);
  });

  it('decrypts AES-256-GCM resources and rejects tag tampering', () => {
    const apiV3Key = '0123456789abcdef0123456789abcdef';
    const encrypted = encryptResource(apiV3Key, '{"trade_state":"SUCCESS"}');

    expect(decryptWechatResource({ apiV3Key, ...encrypted })).toBe('{"trade_state":"SUCCESS"}');
    const tampered = Buffer.from(encrypted.ciphertext, 'base64');
    const finalByte = tampered.at(-1);
    if (finalByte === undefined) throw new Error('ciphertext fixture is empty');
    tampered[tampered.length - 1] = finalByte ^ 1;
    expect(() =>
      decryptWechatResource({
        apiV3Key,
        ...encrypted,
        ciphertext: tampered.toString('base64'),
      }),
    ).toThrow();
  });

  it('selects callback certificates by serial and rejects stale timestamps', async () => {
    const gateway = WechatPayV3Gateway.forTest({
      merchantId: '1900000109',
      merchantSerial: 'merchant-serial',
      privateKeyPem,
      apiV3Key: '0123456789abcdef0123456789abcdef',
      platformCertificates: new Map([['platform-serial', publicKeyPem]]),
      notifyUrl: 'https://example.test/payment/callback',
      now: () => new Date('2026-08-31T12:00:00.000Z'),
    });

    await expect(
      gateway.verifyCallback(
        {
          'wechatpay-serial': 'unknown',
          'wechatpay-timestamp': '1788177600',
          'wechatpay-nonce': 'nonce',
          'wechatpay-signature': 'invalid',
        },
        '{}',
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_UNKNOWN_CERTIFICATE' });
    await expect(
      gateway.verifyCallback(
        {
          'wechatpay-serial': 'platform-serial',
          'wechatpay-timestamp': '1',
          'wechatpay-nonce': 'nonce',
          'wechatpay-signature': 'invalid',
        },
        '{}',
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_CALLBACK_TIMESTAMP_INVALID' });
  });

  it('verifies the exact raw body before decrypting a valid payment', async () => {
    const apiV3Key = '0123456789abcdef0123456789abcdef';
    const paidAt = '2026-08-31T11:59:30+00:00';
    const encrypted = encryptResource(
      apiV3Key,
      JSON.stringify({
        mchid: '1900000109',
        transaction_id: 'wx-transaction-1',
        out_trade_no: 'R-1',
        trade_state: 'SUCCESS',
        success_time: paidAt,
        amount: { total: 1000, currency: 'CNY' },
      }),
    );
    const rawBody = JSON.stringify({
      id: 'callback-1',
      resource: {
        algorithm: 'AEAD_AES_256_GCM',
        nonce: encrypted.nonce,
        associated_data: encrypted.associatedData,
        ciphertext: encrypted.ciphertext,
      },
    });
    const timestamp = '1788177600';
    const nonce = 'callback-nonce';
    const signature = createSign('RSA-SHA256')
      .update(`${timestamp}\n${nonce}\n${rawBody}\n`)
      .end()
      .sign(privateKeyPem, 'base64');
    const gateway = WechatPayV3Gateway.forTest({
      merchantId: '1900000109',
      merchantSerial: 'merchant-serial',
      privateKeyPem,
      apiV3Key,
      platformCertificates: new Map([['platform-serial', publicKeyPem]]),
      notifyUrl: 'https://example.test/payment/callback',
      now: () => new Date('2026-08-31T12:00:00.000Z'),
    });

    await expect(
      gateway.verifyCallback(
        {
          'wechatpay-serial': 'platform-serial',
          'wechatpay-timestamp': timestamp,
          'wechatpay-nonce': nonce,
          'wechatpay-signature': signature,
        },
        rawBody,
      ),
    ).resolves.toEqual({
      transactionId: 'wx-transaction-1',
      orderNo: 'R-1',
      merchantId: '1900000109',
      amountMinor: 1000n,
      currency: 'CNY',
      paidAt: new Date(paidAt),
    });
  });

  it('refuses production construction without KMS references', async () => {
    await expect(
      WechatPayV3Gateway.fromKms(
        {
          appEnv: 'production',
          merchantId: '',
          merchantSerial: '',
          privateKeyRef: '',
          apiV3KeyRef: '',
          platformCertificateRefs: new Map(),
          notifyUrl: '',
        },
        { getSecret: () => Promise.reject(new Error('must not load')) },
      ),
    ).rejects.toMatchObject({ code: 'WECHAT_KMS_CONFIGURATION_REQUIRED' });
  });

  it('starts the fake only for explicit non-production fake configuration', () => {
    expect(() => createFakePaymentGateway({ gatewayName: 'wechat', appEnv: 'test' })).toThrow(
      /FAKE_PAYMENT_NOT_CONFIGURED/,
    );
    expect(() => createFakePaymentGateway({ gatewayName: 'fake', appEnv: 'production' })).toThrow(
      /FAKE_PAYMENT_FORBIDDEN_IN_PRODUCTION/,
    );
    expect(createFakePaymentGateway({ gatewayName: 'fake', appEnv: 'development' })).toBeInstanceOf(
      FakePaymentGateway,
    );
  });
});
