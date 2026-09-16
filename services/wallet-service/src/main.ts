import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { pathToFileURL } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { AdjustmentService } from './application/adjustment.service.js';
import { WalletService } from './application/wallet.service.js';
import {
  InternalWalletController,
  UserWalletController,
  WalletAdjustmentController,
  type AdjustmentApprovalBody,
  type AdjustmentRequestBody,
  type WalletCommandBody,
} from './http/wallet.controller.js';
import { PrismaFinancialControlRepository } from './infrastructure/prisma-financial-control.repository.js';
import { PrismaLedgerRepository } from './infrastructure/prisma-ledger.repository.js';
import { FinanceMetrics } from './observability/finance-metrics.js';
import { WalletHealthService } from './runtime/health.service.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`MISSING_ENVIRONMENT_VARIABLE:${name}`);
  return value;
}

function authorized(request: IncomingMessage, secret: string): boolean {
  const service = request.headers['x-internal-service'];
  const authorization = request.headers.authorization;
  if (typeof service !== 'string' || typeof authorization !== 'string') return false;
  const presented = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
  const actualBuffer = Buffer.from(secret);
  const presentedBuffer = Buffer.from(presented);
  return (
    ['payment-service', 'generation-service'].includes(service) &&
    actualBuffer.length === presentedBuffer.length &&
    timingSafeEqual(actualBuffer, presentedBuffer)
  );
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<unknown>) {
    if (!(typeof chunk === 'string' || chunk instanceof Uint8Array)) {
      throw new Error('REQUEST_BODY_CHUNK_INVALID');
    }
    const buffer = Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65_536) throw new Error('REQUEST_BODY_TOO_LARGE');
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('JSON_OBJECT_REQUIRED');
  return value as Record<string, unknown>;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function errorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.message : 'INTERNAL_ERROR';
}

export function bootstrapWalletService(): void {
  const databaseUrl = required('DATABASE_URL');
  const internalSecret = required('INTERNAL_SERVICE_TOKEN');
  const port = Number(process.env.PORT ?? '3012');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PORT_INVALID');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
  const metrics = new FinanceMetrics('wallet');
  const ledger = new PrismaLedgerRepository(prisma, {
    onSerializableRetry: () => {
      metrics.increment('serializable_retries');
    },
  });
  const wallet = new WalletService(ledger);
  const financial = new PrismaFinancialControlRepository(prisma);
  const approvers = new Set(
    required('WALLET_ADJUSTMENT_APPROVERS')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const adjustments = new AdjustmentService(financial, wallet, {
    canApprove: (adminId) => approvers.has(adminId),
  });
  const internal = new InternalWalletController(wallet);
  const user = new UserWalletController(wallet);
  const adjustment = new WalletAdjustmentController(adjustments);
  const health = new WalletHealthService({
    ping: async () => {
      await prisma.$queryRaw`SELECT 1`;
    },
  });

  const handleRequest = async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const url = new URL(request.url ?? '/', 'http://wallet.local');
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
          'blocked_wallets',
          await prisma.walletRestriction.count({ where: { unblockedAt: null } }),
        );
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
        response.end(metrics.render());
        return;
      }
      if (url.pathname.startsWith('/internal/') && !authorized(request, internalSecret)) {
        sendJson(response, 401, { code: 'UNAUTHORIZED_INTERNAL_CALL' });
        return;
      }
      if (request.method === 'POST' && url.pathname.startsWith('/internal/wallet/')) {
        const operation = url.pathname.slice('/internal/wallet/'.length);
        if (['credit', 'refund', 'reserve', 'settle', 'release'].includes(operation)) {
          const body = (await readJson(request)) as unknown as WalletCommandBody;
          const handlers = {
            credit: () => internal.credit(body),
            refund: () => internal.refund(body),
            reserve: () => internal.reserve(body),
            settle: () => internal.settle(body),
            release: () => internal.release(body),
          };
          const handler = handlers[operation as keyof typeof handlers];
          const result = await handler();
          metrics.increment('ledger_postings');
          sendJson(response, 200, result);
          return;
        }
      }
      if (request.method === 'POST' && url.pathname === '/internal/wallet/adjustments') {
        sendJson(
          response,
          201,
          await adjustment.request((await readJson(request)) as unknown as AdjustmentRequestBody),
        );
        return;
      }
      const approvalMatch = /^\/internal\/wallet\/adjustments\/([^/]+)\/approve$/.exec(
        url.pathname,
      );
      if (request.method === 'POST' && approvalMatch?.[1]) {
        sendJson(
          response,
          200,
          await adjustment.approve(
            approvalMatch[1],
            (await readJson(request)) as unknown as AdjustmentApprovalBody,
          ),
        );
        return;
      }
      if (request.method === 'GET' && url.pathname.startsWith('/v1/wallet')) {
        const userId = request.headers['x-user-id'];
        if (typeof userId !== 'string') {
          sendJson(response, 401, { code: 'USER_PRINCIPAL_REQUIRED' });
          return;
        }
        sendJson(
          response,
          200,
          url.pathname === '/v1/wallet/transactions'
            ? await user.transactions(userId)
            : await user.balance(userId),
        );
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
    server.close(() => void prisma.$disconnect().finally(() => process.exit(0)));
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    bootstrapWalletService();
  } catch (error: unknown) {
    process.stderr.write(`${errorCode(error)}\n`);
    process.exitCode = 1;
  }
}
