import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { createFakePaymentGateway } from './adapters/fake-payment.gateway.js';
import { WechatPayV3Gateway } from './adapters/wechat-pay-v3.gateway.js';
import { ChannelReconciliationJob } from './application/channel-reconciliation.job.js';
import { InvoiceService } from './application/invoice.service.js';
import { OrderService } from './application/order.service.js';
import { PaymentCallbackService } from './application/payment-callback.service.js';
import { RefundService } from './application/refund.service.js';
import {
  HttpKmsSecretProvider,
  HttpRechargePackageProvider,
  HttpWalletPort,
} from './infrastructure/http-finance.ports.js';
import { PrismaPaymentRepository } from './infrastructure/prisma-payment.repository.js';
import { FinanceMetrics } from './observability/finance-metrics.js';
import type { PaymentGateway } from './ports/payment-gateway.js';
import { PaymentHealthService } from './runtime/health.service.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENVIRONMENT_VARIABLE:${name}`);
  return value;
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.message : 'INTERNAL_ERROR';
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? item.toString() : item,
    ),
  );
}

async function readRaw(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    if (!(typeof chunk === 'string' || chunk instanceof Uint8Array)) {
      throw new Error('REQUEST_BODY_CHUNK_INVALID');
    }
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_048_576) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const value = JSON.parse(await readRaw(request)) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('JSON_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

function requestHeaders(request: IncomingMessage): Record<string, string> {
  return Object.fromEntries(
    Object.entries(request.headers)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
      .map(([name, value]) => [name.toLowerCase(), value]),
  );
}

function authorized(request: IncomingMessage, secret: string): boolean {
  const service = request.headers['x-internal-service'];
  const authorization = request.headers.authorization;
  if (typeof service !== 'string' || typeof authorization !== 'string') return false;
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const actualBuffer = Buffer.from(secret);
  const presentedBuffer = Buffer.from(presented);
  return (
    ['wallet-service', 'operations-service'].includes(service) &&
    actualBuffer.length === presentedBuffer.length &&
    timingSafeEqual(actualBuffer, presentedBuffer)
  );
}

function parseCertificateReferences(value: string): Map<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('WECHAT_CERTIFICATE_REFERENCES_INVALID');
  }
  const references = new Map<string, string>();
  for (const [serial, reference] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof reference !== 'string' || !serial || !reference) {
      throw new Error('WECHAT_CERTIFICATE_REFERENCES_INVALID');
    }
    references.set(serial, reference);
  }
  if (references.size === 0) throw new Error('WECHAT_CERTIFICATE_REFERENCES_INVALID');
  return references;
}

async function createGateway(appEnv: string): Promise<{
  gateway: PaymentGateway;
  certificateAvailable: () => Promise<boolean>;
}> {
  const gatewayName = required('PAYMENT_GATEWAY');
  if (gatewayName === 'fake') {
    return {
      gateway: createFakePaymentGateway({ gatewayName, appEnv }),
      certificateAvailable: () => Promise.resolve(true),
    };
  }
  if (gatewayName !== 'wechat-v3') throw new Error('PAYMENT_GATEWAY_UNSUPPORTED');
  const gateway = await WechatPayV3Gateway.fromKms(
    {
      appEnv,
      merchantId: required('WECHAT_MERCHANT_ID'),
      merchantSerial: required('WECHAT_MERCHANT_SERIAL'),
      privateKeyRef: required('WECHAT_PRIVATE_KEY_REF'),
      apiV3KeyRef: required('WECHAT_API_V3_KEY_REF'),
      platformCertificateRefs: parseCertificateReferences(
        required('WECHAT_PLATFORM_CERTIFICATE_REFS'),
      ),
      notifyUrl: required('PAYMENT_NOTIFY_URL'),
    },
    new HttpKmsSecretProvider(required('KMS_ENDPOINT'), required('KMS_TOKEN')),
  );
  return {
    gateway,
    certificateAvailable: () => Promise.resolve(gateway.hasUsableCertificate()),
  };
}

export async function bootstrapPaymentService(): Promise<void> {
  const databaseUrl = required('DATABASE_URL');
  const appEnv = required('APP_ENV');
  const internalToken = required('INTERNAL_SERVICE_TOKEN');
  const port = Number(process.env.PORT ?? '3013');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT_INVALID');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const gatewayRuntime = await createGateway(appEnv);
  const repository = new PrismaPaymentRepository(
    prisma,
    new HttpRechargePackageProvider(required('OPERATIONS_SERVICE_URL'), internalToken),
  );
  const wallet = new HttpWalletPort(required('WALLET_SERVICE_URL'), internalToken);
  const orders = new OrderService(
    repository,
    gatewayRuntime.gateway,
    required('PAYMENT_NOTIFY_URL'),
  );
  const callbacks = new PaymentCallbackService(repository, gatewayRuntime.gateway, wallet, {
    merchantId: required('WECHAT_MERCHANT_ID'),
  });
  const refunds = new RefundService(repository, gatewayRuntime.gateway, wallet, {
    authorizedReasons: new Set(
      required('PAYMENT_REFUND_REASONS')
        .split(',')
        .map((reason) => reason.trim())
        .filter(Boolean),
    ),
  });
  const invoices = new InvoiceService(repository);
  const reconciliation = new ChannelReconciliationJob(repository, gatewayRuntime.gateway);
  const metrics = new FinanceMetrics('payment');
  const health = new PaymentHealthService(
    {
      ping: async () => {
        await prisma.$queryRaw`SELECT 1`;
      },
    },
    { isAvailable: gatewayRuntime.certificateAvailable },
  );
  const creditWorker = setInterval(() => {
    void callbacks.drainPendingWalletCredits().catch(() => {
      metrics.increment('callback_failures');
    });
  }, 5_000);
  const queryRecoveryWorker = setInterval(() => {
    void callbacks.recoverStalePending().catch(() => {
      metrics.increment('callback_failures');
    });
  }, 60_000);

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', 'http://payment.local');
      if (request.method === 'GET' && url.pathname === '/live') {
        sendJson(response, 200, health.liveness());
        return;
      }
      if (request.method === 'GET' && url.pathname === '/ready') {
        const readiness = await health.readiness();
        sendJson(response, readiness.ready ? 200 : 503, readiness);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/metrics') {
        metrics.set(
          'refund_backlog',
          await prisma.refundOrder.count({
            where: { status: { in: ['PENDING', 'PROCESSING', 'FAILED'] } },
          }),
        );
        const latest = await prisma.channelReconciliation.findFirst({
          orderBy: { startedAt: 'desc' },
          select: { differenceCount: true },
        });
        metrics.set('reconciliation_differences', latest?.differenceCount ?? 0);
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(metrics.render());
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/payments/orders') {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') {
          sendJson(response, 401, { code: 'USER_PRINCIPAL_REQUIRED' });
          return;
        }
        const body = await readJson(request);
        sendJson(
          response,
          201,
          await orders.create({
            userId,
            packageId: typeof body.packageId === 'string' ? body.packageId : '',
            traceId: typeof body.traceId === 'string' ? body.traceId : '',
          }),
        );
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/payments/wechat/callback') {
        const rawBody = await readRaw(request);
        try {
          await callbacks.handle(requestHeaders(request), rawBody);
          sendJson(response, 200, { code: 'SUCCESS', message: '成功' });
        } catch (error) {
          metrics.increment('callback_failures');
          throw error;
        }
        return;
      }
      if (url.pathname.startsWith('/internal/') && !authorized(request, internalToken)) {
        sendJson(response, 401, { code: 'UNAUTHORIZED_INTERNAL_CALL' });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/internal/payments/refunds') {
        const body = await readJson(request);
        sendJson(
          response,
          200,
          await refunds.refund({
            orderId: typeof body.orderId === 'string' ? body.orderId : '',
            userId: typeof body.userId === 'string' ? body.userId : '',
            refundNo: typeof body.refundNo === 'string' ? body.refundNo : '',
            reason: typeof body.reason === 'string' ? body.reason : '',
            traceId: typeof body.traceId === 'string' ? body.traceId : '',
          }),
        );
        return;
      }
      const reconciliationMatch =
        /^\/internal\/payments\/reconciliation\/(\d{4}-\d{2}-\d{2})$/.exec(url.pathname);
      if (request.method === 'POST' && reconciliationMatch?.[1]) {
        const result = await reconciliation.run(reconciliationMatch[1]);
        metrics.set('reconciliation_differences', result.differences.length);
        sendJson(response, 200, result);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/v1/invoices') {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') {
          sendJson(response, 401, { code: 'USER_PRINCIPAL_REQUIRED' });
          return;
        }
        const body = await readJson(request);
        sendJson(
          response,
          201,
          await invoices.apply({
            userId,
            orderId: typeof body.orderId === 'string' ? body.orderId : '',
            title: typeof body.title === 'string' ? body.title : '',
            ...(typeof body.taxNo === 'string' ? { taxNo: body.taxNo } : {}),
          }),
        );
        return;
      }
      const invoiceMatch = /^\/internal\/invoices\/([^/]+)\/(approve|issue|reject)$/.exec(
        url.pathname,
      );
      if (request.method === 'POST' && invoiceMatch?.[1] && invoiceMatch[2]) {
        const body = invoiceMatch[2] === 'reject' ? await readJson(request) : {};
        const result =
          invoiceMatch[2] === 'approve'
            ? await invoices.approve(invoiceMatch[1])
            : invoiceMatch[2] === 'issue'
              ? await invoices.issue(invoiceMatch[1])
              : await invoices.reject(
                  invoiceMatch[1],
                  typeof body.reason === 'string' ? body.reason : '',
                );
        sendJson(response, 200, result);
        return;
      }
      sendJson(response, 404, { code: 'NOT_FOUND' });
    } catch (error) {
      const code = errorCode(error);
      sendJson(response, code === 'INTERNAL_ERROR' ? 500 : 422, { code });
    }
  };
  const server = createServer((request, response) => {
    void handleRequest(request, response);
  });
  server.listen(port, '0.0.0.0');
  const shutdown = (): void => {
    clearInterval(creditWorker);
    clearInterval(queryRecoveryWorker);
    server.close(() => void prisma.$disconnect().finally(() => process.exit(0)));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrapPaymentService().catch((error: unknown) => {
    process.stderr.write(`${errorCode(error)}\n`);
    process.exitCode = 1;
  });
}
