import { uuidV7 } from '../domain/uuid-v7.js';
import type { PaymentGateway } from '../ports/payment-gateway.js';
import type {
  PaymentFinancialRepository,
  ReconciliationDifference,
} from './payment-financial.repository.js';

interface ChannelBillRow {
  orderNo: string;
  transactionId: string;
  amountMinor: bigint;
  status: string;
}

export interface ChannelReconciliationResult {
  status: 'MATCHED' | 'MISMATCHED';
  differences: readonly ReconciliationDifference[];
}

function reconciliationError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream as AsyncIterable<unknown>) {
    if (typeof chunk === 'string') chunks.push(Buffer.from(chunk));
    else if (chunk instanceof Uint8Array) chunks.push(Buffer.from(chunk));
    else throw reconciliationError('CHANNEL_BILL_CHUNK_INVALID');
  }
  return Buffer.concat(chunks).toString('utf8');
}

function parseBill(text: string): ChannelBillRow[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines[0] !== 'order_no,transaction_id,amount_minor,status') {
    throw reconciliationError('CHANNEL_BILL_HEADER_INVALID');
  }
  return lines
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const [orderNo, transactionId, amountMinor, status, extra] = line.split(',');
      if (!orderNo || !transactionId || !amountMinor || !status || extra !== undefined) {
        throw reconciliationError('CHANNEL_BILL_ROW_INVALID');
      }
      if (!/^\d+$/.test(amountMinor)) throw reconciliationError('CHANNEL_BILL_AMOUNT_INVALID');
      return { orderNo, transactionId, amountMinor: BigInt(amountMinor), status };
    });
}

function utcDay(date: string): { billDate: Date; from: Date; to: Date } {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw reconciliationError('BILL_DATE_INVALID');
  const from = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime())) throw reconciliationError('BILL_DATE_INVALID');
  const to = new Date(from.getTime() + 86_400_000);
  return { billDate: from, from, to };
}

export class ChannelReconciliationJob {
  constructor(
    private readonly repository: PaymentFinancialRepository,
    private readonly gateway: PaymentGateway,
  ) {}

  async run(date: string): Promise<ChannelReconciliationResult> {
    const range = utcDay(date);
    const [stream, platformOrders] = await Promise.all([
      this.gateway.downloadBill(date),
      this.repository.listPaidOrders(range.from, range.to),
    ]);
    const channelRows = parseBill(await readStream(stream));
    const channelByOrder = new Map(channelRows.map((row) => [row.orderNo, row]));
    const platformByOrder = new Map(platformOrders.map((order) => [order.orderNo, order]));
    const differences: ReconciliationDifference[] = [];

    for (const row of channelRows) {
      const order = platformByOrder.get(row.orderNo);
      if (!order) {
        differences.push({
          kind: 'CHANNEL_ONLY',
          orderNo: row.orderNo,
          severity: 'P0',
          channelTransactionId: row.transactionId,
          channelAmountMinor: row.amountMinor,
        });
        continue;
      }
      if (row.amountMinor !== order.amountMinor) {
        differences.push({
          kind: 'AMOUNT_MISMATCH',
          orderNo: row.orderNo,
          severity: 'P0',
          channelAmountMinor: row.amountMinor,
          platformAmountMinor: order.amountMinor,
        });
      }
      if (row.transactionId !== order.transactionId) {
        differences.push({
          kind: 'TRANSACTION_ID_MISMATCH',
          orderNo: row.orderNo,
          severity: 'P1',
          channelTransactionId: row.transactionId,
          ...(order.transactionId ? { platformTransactionId: order.transactionId } : {}),
        });
      }
      if (row.status !== 'SUCCESS' || order.status !== 'PAID') {
        differences.push({ kind: 'STATUS_MISMATCH', orderNo: row.orderNo, severity: 'P1' });
      }
    }
    for (const order of platformOrders) {
      if (!channelByOrder.has(order.orderNo)) {
        differences.push({
          kind: 'PLATFORM_ONLY',
          orderNo: order.orderNo,
          severity: 'P0',
          ...(order.transactionId ? { platformTransactionId: order.transactionId } : {}),
          platformAmountMinor: order.amountMinor,
        });
      }
    }

    await this.repository.saveReconciliation({
      id: uuidV7(),
      billDate: range.billDate,
      differences,
    });
    return { status: differences.length === 0 ? 'MATCHED' : 'MISMATCHED', differences };
  }
}
