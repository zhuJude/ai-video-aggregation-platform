export interface SmsSendInput {
  notificationId: string;
  phoneE164: string;
  signName: string;
  templateCode: string;
  variables: Readonly<Record<string, string>>;
  sendStartedAt: Date;
  sendDate: string;
}

export interface SmsSendResult {
  status: 'ACCEPTED';
  requestId: string;
  receipt: string;
}

export interface SmsReceiptResult {
  status: 'DELIVERED' | 'PENDING' | 'FAILED' | 'NOT_ACCEPTED';
  requestId: string;
  receipt?: string;
}

/** Provider calls use notificationId as the stable external idempotency/out-id key. */
export interface SmsSender {
  send(input: SmsSendInput): Promise<SmsSendResult>;
  reconcile(
    input: SmsSendInput & { requestId?: string; receipt?: string },
  ): Promise<SmsReceiptResult>;
}

export type SmsFailureKind = 'TRANSIENT' | 'PERMANENT';

export class SmsDeliveryError extends Error {
  constructor(
    readonly kind: SmsFailureKind,
    readonly code: string,
    message = code,
    readonly acceptance: 'UNKNOWN' | 'NOT_ATTEMPTED' = 'UNKNOWN',
  ) {
    super(message);
    this.name = 'SmsDeliveryError';
  }
}
