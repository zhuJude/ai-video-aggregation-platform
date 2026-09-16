import { uuidV7 } from '../domain/uuid-v7.js';
import type { InvoiceRecord, PaymentFinancialRepository } from './payment-financial.repository.js';

function invoiceError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export class InvoiceService {
  constructor(private readonly repository: PaymentFinancialRepository) {}

  async apply(input: {
    userId: string;
    orderId: string;
    title: string;
    taxNo?: string;
  }): Promise<InvoiceRecord> {
    const order = await this.repository.findFinancialOrder(input.orderId);
    if (!order) throw invoiceError('PAYMENT_ORDER_NOT_FOUND');
    if (order.userId !== input.userId) throw invoiceError('INVOICE_ORDER_OWNERSHIP_MISMATCH');
    if (order.status !== 'PAID') throw invoiceError('INVOICE_ORDER_NOT_PAID');
    if (!input.title.trim()) throw invoiceError('INVOICE_TITLE_REQUIRED');
    return this.repository.createInvoice({
      id: uuidV7(),
      userId: input.userId,
      orderId: input.orderId,
      amountMinor: order.amountMinor,
      title: input.title.trim(),
      ...(input.taxNo ? { taxNo: input.taxNo } : {}),
      status: 'APPLIED',
    });
  }

  approve(invoiceId: string): Promise<InvoiceRecord> {
    return this.repository.updateInvoice({
      invoiceId,
      expectedStatus: ['APPLIED'],
      nextStatus: 'APPROVED',
    });
  }

  issue(invoiceId: string): Promise<InvoiceRecord> {
    return this.repository.updateInvoice({
      invoiceId,
      expectedStatus: ['APPROVED'],
      nextStatus: 'ISSUED',
      issuedAt: new Date(),
    });
  }

  reject(invoiceId: string, reason: string): Promise<InvoiceRecord> {
    if (!reason.trim()) return Promise.reject(invoiceError('INVOICE_REJECTION_REASON_REQUIRED'));
    return this.repository.updateInvoice({
      invoiceId,
      expectedStatus: ['APPLIED', 'APPROVED'],
      nextStatus: 'REJECTED',
      rejectionReason: reason.trim(),
    });
  }
}
