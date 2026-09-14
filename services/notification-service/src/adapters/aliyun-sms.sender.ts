import DysmsClient, {
  QuerySendDetailsRequest,
  QuerySmsSignRequest,
  SendSmsRequest,
} from '@alicloud/dysmsapi20170525';
import type {
  SmsReceiptResult,
  SmsSendInput,
  SmsSendResult,
  SmsSender,
} from '../ports/sms-sender.js';
import { SmsDeliveryError } from '../ports/sms-sender.js';

export interface AliyunSmsConfig {
  roleArn: string;
  credentialKmsRef: string;
  endpoint: string;
  approvedSigns: readonly string[];
  approvedTemplateCodes: readonly string[];
}

interface AliyunSmsResponse {
  body?: { code?: string; message?: string; requestId?: string; bizId?: string };
}
interface AliyunQueryResponse {
  body?: {
    code?: string;
    message?: string;
    requestId?: string;
    totalCount?: string;
    smsSendDetailDTOs?: {
      smsSendDetailDTO?: { outId?: string; sendStatus?: number; errCode?: string }[];
    };
  };
}

export interface AliyunSmsClient {
  ping?(): Promise<void>;
  sendSms(
    request: SendSmsRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<AliyunSmsResponse>;
  querySendDetails(
    request: QuerySendDetailsRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<AliyunQueryResponse>;
}

export interface RamRoleCredentialResolver {
  resolve(input: { roleArn: string; kmsReference: string }): Promise<{
    accessKeyId: string;
    accessKeySecret: string;
    securityToken: string;
    expiresAt: Date;
  }>;
}

export interface KmsSecretResolver {
  resolveSecret(reference: string): Promise<string>;
}

export interface RamRoleSessionIssuer {
  assumeRole(input: {
    roleArn: string;
    externalId: string;
  }): ReturnType<RamRoleCredentialResolver['resolve']>;
}

interface RamRoleSession {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
  expiresAt: Date;
}

type AliyunClientFactory = (
  session: RamRoleSession,
  endpoint: string,
  signName: string,
) => AliyunSmsClient;

/** Resolves sensitive role parameters by KMS reference, then mints short-lived RAM credentials. */
export class KmsRamRoleCredentialResolver implements RamRoleCredentialResolver {
  constructor(
    private readonly kms: KmsSecretResolver,
    private readonly ram: RamRoleSessionIssuer,
  ) {}

  async resolve(input: { roleArn: string; kmsReference: string }) {
    if (!/^kms:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$/.test(input.kmsReference))
      throw new Error('KMS_REFERENCE_REQUIRED');
    const externalId = await this.kms.resolveSecret(input.kmsReference);
    if (externalId.length === 0) throw new Error('INVALID_KMS_ROLE_CONFIGURATION');
    return this.ram.assumeRole({ roleArn: input.roleArn, externalId });
  }
}

export type SafeSmsLogger = (record: {
  event: string;
  phone: string;
  requestId?: string;
  receipt?: string;
  code?: string;
}) => void;

export function loadAliyunSmsConfig(input: AliyunSmsConfig): AliyunSmsConfig {
  if (!/^kms:\/\/[A-Za-z0-9][A-Za-z0-9/_-]{2,255}$/.test(input.credentialKmsRef))
    throw new Error('KMS_REFERENCE_REQUIRED');
  if (!/^acs:ram::[A-Za-z0-9]+:role\/[A-Za-z0-9_-]+$/.test(input.roleArn))
    throw new Error('RAM_ROLE_REQUIRED');
  if (!/^[A-Za-z0-9.-]+\.aliyuncs\.com$/.test(input.endpoint))
    throw new Error('ALIYUN_ENDPOINT_REQUIRED');
  if (input.approvedSigns.length === 0 || input.approvedTemplateCodes.length === 0)
    throw new Error('SMS_ALLOWLIST_REQUIRED');
  return {
    ...input,
    approvedSigns: [...new Set(input.approvedSigns)],
    approvedTemplateCodes: [...new Set(input.approvedTemplateCodes)],
  };
}

export async function createAliyunSdkSmsClient(
  input: AliyunSmsConfig,
  credentials: RamRoleCredentialResolver,
  options: {
    now?: () => Date;
    refreshBeforeMs?: number;
    clientFactory?: AliyunClientFactory;
  } = {},
): Promise<AliyunSmsClient> {
  const client = new RefreshingAliyunSmsClient(input, credentials, options);
  await client.initialize();
  return client;
}

export class RefreshingAliyunSmsClient implements AliyunSmsClient {
  private readonly config: AliyunSmsConfig;
  private readonly now: () => Date;
  private readonly refreshBeforeMs: number;
  private readonly clientFactory: AliyunClientFactory;
  private current: { client: AliyunSmsClient; expiresAt: Date; sessionId: string } | null = null;
  private refreshInFlight: Promise<AliyunSmsClient> | null = null;

  constructor(
    input: AliyunSmsConfig,
    private readonly credentials: RamRoleCredentialResolver,
    options: {
      now?: () => Date;
      refreshBeforeMs?: number;
      clientFactory?: AliyunClientFactory;
    } = {},
  ) {
    this.config = loadAliyunSmsConfig(input);
    this.now = options.now ?? (() => new Date());
    this.refreshBeforeMs = options.refreshBeforeMs ?? 5 * 60_000;
    this.clientFactory = options.clientFactory ?? createRawAliyunClient;
  }

  async initialize(): Promise<void> {
    await this.client();
  }

  async ping(): Promise<void> {
    const client = await this.client();
    if (client.ping === undefined) throw new Error('ALIYUN_SMS_PROBE_UNAVAILABLE');
    await client.ping();
  }

  async sendSms(
    request: SendSmsRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<AliyunSmsResponse> {
    return (await this.client()).sendSms(request, options);
  }

  async querySendDetails(
    request: QuerySendDetailsRequest,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<AliyunQueryResponse> {
    return (await this.client()).querySendDetails(request, options);
  }

  private async client(): Promise<AliyunSmsClient> {
    const now = this.now();
    if (
      this.current !== null &&
      this.current.expiresAt.getTime() - this.refreshBeforeMs > now.getTime()
    )
      return this.current.client;
    this.refreshInFlight ??= this.refresh();
    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }

  private async refresh(): Promise<AliyunSmsClient> {
    try {
      const session = await this.credentials.resolve({
        roleArn: this.config.roleArn,
        kmsReference: this.config.credentialKmsRef,
      });
      validateSession(session, this.now());
      const sessionId = ramSessionIdentity(session);
      if (this.current?.sessionId === sessionId) return this.current.client;
      const signName = this.config.approvedSigns[0];
      if (signName === undefined) throw new Error('SMS_ALLOWLIST_REQUIRED');
      const client = this.clientFactory(session, this.config.endpoint, signName);
      this.current = { client, expiresAt: session.expiresAt, sessionId };
      return client;
    } catch {
      const current = this.current;
      if (current !== null && current.expiresAt > this.now()) return current.client;
      throw new SmsDeliveryError(
        'TRANSIENT',
        'RAM_CREDENTIAL_REFRESH_FAILED',
        'RAM_CREDENTIAL_REFRESH_FAILED',
        'NOT_ATTEMPTED',
      );
    }
  }
}

function validateSession(session: RamRoleSession, now: Date): void {
  if (
    session.accessKeyId.length === 0 ||
    session.accessKeySecret.length === 0 ||
    session.securityToken.length === 0 ||
    !Number.isFinite(session.expiresAt.getTime()) ||
    session.expiresAt <= now ||
    session.expiresAt.getTime() - now.getTime() > 3_600_000
  )
    throw new Error('INVALID_RAM_ROLE_SESSION');
}

function ramSessionIdentity(session: RamRoleSession): string {
  return `${session.accessKeyId}\0${session.securityToken}\0${session.expiresAt.toISOString()}`;
}

function createRawAliyunClient(
  session: RamRoleSession,
  endpoint: string,
  signName: string,
): AliyunSmsClient {
  interface RawAliyunClient {
    querySmsSignWithOptions(
      request: QuerySmsSignRequest,
      runtime: RawRuntimeOptions,
    ): Promise<unknown>;
    sendSmsWithOptions(
      request: SendSmsRequest,
      runtime: RawRuntimeOptions,
    ): Promise<AliyunSmsResponse>;
    querySendDetailsWithOptions(
      request: QuerySendDetailsRequest,
      runtime: RawRuntimeOptions,
    ): Promise<AliyunQueryResponse>;
  }
  type ClientConstructor = new (config: {
    accessKeyId: string;
    accessKeySecret: string;
    securityToken: string;
    endpoint: string;
    type: string;
  }) => RawAliyunClient;
  const moduleValue = DysmsClient as unknown as ClientConstructor | { default: ClientConstructor };
  const Client = typeof moduleValue === 'function' ? moduleValue : moduleValue.default;
  const raw = new Client({
    accessKeyId: session.accessKeyId,
    accessKeySecret: session.accessKeySecret,
    securityToken: session.securityToken,
    endpoint,
    type: 'access_key',
  });
  return {
    ping: async () => {
      await raw.querySmsSignWithOptions(
        new QuerySmsSignRequest({ signName }),
        runtimeOptions(2_000),
      );
    },
    sendSms: (request, options) =>
      raw.sendSmsWithOptions(request, runtimeOptions(options?.timeoutMs)),
    querySendDetails: (request, options) =>
      raw.querySendDetailsWithOptions(request, runtimeOptions(options?.timeoutMs)),
  };
}

interface RawRuntimeOptions {
  autoretry: boolean;
  maxAttempts: number;
  connectTimeout: number;
  readTimeout: number;
}

function runtimeOptions(timeoutMs = 5_000): RawRuntimeOptions {
  return {
    autoretry: false,
    maxAttempts: 1,
    connectTimeout: timeoutMs,
    readTimeout: timeoutMs,
  };
}

/**
 * Production adapter for @alicloud/dysmsapi20170525@4.6.0.
 * Client credentials are composed outside this class from an ACK workload RAM role;
 * only its KMS reference is configuration, never access keys or secrets.
 */
export class AliyunSmsSender implements SmsSender {
  private readonly config: AliyunSmsConfig;
  private readonly limits: Required<AliyunSmsSenderLimits>;
  constructor(
    private readonly client: AliyunSmsClient,
    config: AliyunSmsConfig,
    private readonly log: SafeSmsLogger = () => undefined,
    private readonly now: () => Date = () => new Date(),
    limits: AliyunSmsSenderLimits = {},
  ) {
    this.config = loadAliyunSmsConfig(config);
    this.limits = {
      maxPages: limits.maxPages ?? 100,
      maxRecords: limits.maxRecords ?? 5_000,
      requestTimeoutMs: limits.requestTimeoutMs ?? 5_000,
      reconcileTimeoutMs: limits.reconcileTimeoutMs ?? 20_000,
    };
    if (
      !Number.isInteger(this.limits.maxPages) ||
      this.limits.maxPages < 1 ||
      !Number.isInteger(this.limits.maxRecords) ||
      this.limits.maxRecords < 1 ||
      !Number.isInteger(this.limits.requestTimeoutMs) ||
      this.limits.requestTimeoutMs < 1 ||
      !Number.isInteger(this.limits.reconcileTimeoutMs) ||
      this.limits.reconcileTimeoutMs < this.limits.requestTimeoutMs
    )
      throw new Error('INVALID_SMS_DELIVERY_LIMITS');
  }

  async send(input: SmsSendInput): Promise<SmsSendResult> {
    this.assertApproved(input);
    let response: AliyunSmsResponse;
    try {
      response = await withDeadline(
        (signal) =>
          this.client.sendSms(
            new SendSmsRequest({
              phoneNumbers: input.phoneE164.replace(/^\+86/, ''),
              signName: input.signName,
              templateCode: input.templateCode,
              templateParam: JSON.stringify(input.variables),
              outId: input.notificationId,
            }),
            { signal, timeoutMs: this.limits.requestTimeoutMs },
          ),
        this.limits.requestTimeoutMs,
        'ALIYUN_SEND_TIMEOUT',
      );
    } catch (error) {
      throw mapProviderFailure(error);
    }
    const code = response.body?.code ?? 'MISSING_CODE';
    if (code !== 'OK') throw providerCodeError(code, response.body?.message);
    const requestId = response.body?.requestId;
    const receipt = response.body?.bizId;
    if (
      requestId === undefined ||
      requestId.length === 0 ||
      receipt === undefined ||
      receipt.length === 0
    )
      throw new SmsDeliveryError('PERMANENT', 'ALIYUN_MALFORMED_ACCEPTANCE');
    this.log({ event: 'sms.send', phone: maskPhone(input.phoneE164), requestId, receipt, code });
    return { status: 'ACCEPTED', requestId, receipt };
  }

  async reconcile(
    input: SmsSendInput & { requestId?: string; receipt?: string },
  ): Promise<SmsReceiptResult> {
    return withDeadline(
      (signal) => this.reconcileWithinDeadline(input, signal),
      this.limits.reconcileTimeoutMs,
      'ALIYUN_RECONCILE_TIMEOUT',
    );
  }

  private async reconcileWithinDeadline(
    input: SmsSendInput & { requestId?: string; receipt?: string },
    reconcileSignal: AbortSignal,
  ): Promise<SmsReceiptResult> {
    this.assertApproved(input);
    if (!Number.isFinite(input.sendStartedAt.getTime()))
      throw new SmsDeliveryError('PERMANENT', 'INVALID_SEND_STARTED_AT');
    if (!/^\d{8}$/.test(input.sendDate) || input.sendDate !== formatSendDate(input.sendStartedAt))
      throw new SmsDeliveryError('PERMANENT', 'INVALID_SEND_DATE');
    if (this.now().getTime() - input.sendStartedAt.getTime() > 30 * 86_400_000)
      throw new SmsDeliveryError('PERMANENT', 'RECEIPT_WINDOW_EXPIRED');
    let lastRequestId: string | null = null;
    let pagesScanned = 0;
    let recordsScanned = 0;
    for (const sendDate of reconciliationDates(input.sendStartedAt, input.sendDate)) {
      let currentPage = 1;
      let hasMore = true;
      let expectedTotal: number | null = null;
      let dateRecords = 0;
      while (hasMore) {
        if (pagesScanned >= this.limits.maxPages || recordsScanned >= this.limits.maxRecords)
          throw new SmsDeliveryError('TRANSIENT', 'RECONCILIATION_SCAN_LIMIT');
        let response: AliyunQueryResponse;
        try {
          response = await withDeadline(
            (signal) =>
              this.client.querySendDetails(
                new QuerySendDetailsRequest({
                  phoneNumber: input.phoneE164.replace(/^\+86/, ''),
                  ...(input.receipt === undefined ? {} : { bizId: input.receipt }),
                  sendDate,
                  pageSize: 50,
                  currentPage,
                }),
                { signal, timeoutMs: this.limits.requestTimeoutMs },
              ),
            this.limits.requestTimeoutMs,
            'ALIYUN_QUERY_TIMEOUT',
            reconcileSignal,
          );
        } catch (error) {
          throw mapProviderFailure(error);
        }
        const code = response.body?.code ?? 'MISSING_CODE';
        if (code !== 'OK') throw providerCodeError(code, response.body?.message);
        const requestId = response.body?.requestId;
        if (requestId === undefined || requestId.length === 0)
          throw new SmsDeliveryError('TRANSIENT', 'ALIYUN_MALFORMED_QUERY_RESPONSE');
        lastRequestId = requestId;
        const detailsValue: unknown = response.body?.smsSendDetailDTOs?.smsSendDetailDTO ?? [];
        if (!isAliyunDetails(detailsValue))
          throw new SmsDeliveryError('TRANSIENT', 'ALIYUN_INCONSISTENT_QUERY_RESPONSE');
        const details = detailsValue;
        const totalCount = parseTotalCount(response.body?.totalCount);
        if (
          totalCount === null ||
          details.length > 50 ||
          (expectedTotal !== null && expectedTotal !== totalCount) ||
          dateRecords + details.length > totalCount
        )
          throw new SmsDeliveryError('TRANSIENT', 'ALIYUN_INCONSISTENT_QUERY_RESPONSE');
        expectedTotal = totalCount;
        pagesScanned += 1;
        recordsScanned += details.length;
        dateRecords += details.length;
        if (recordsScanned > this.limits.maxRecords)
          throw new SmsDeliveryError('TRANSIENT', 'RECONCILIATION_SCAN_LIMIT');
        const detail = details.find((candidate) => candidate.outId === input.notificationId);
        if (detail !== undefined) {
          if (detail.sendStatus !== 1 && detail.sendStatus !== 2 && detail.sendStatus !== 3)
            throw new SmsDeliveryError('TRANSIENT', 'ALIYUN_INCONSISTENT_QUERY_RESPONSE');
          const status =
            detail.sendStatus === 1 ? 'PENDING' : detail.sendStatus === 3 ? 'DELIVERED' : 'FAILED';
          const result: SmsReceiptResult = {
            status,
            requestId,
            ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
          };
          this.logReceipt(
            input,
            result,
            typeof detail.errCode === 'string' ? detail.errCode : code,
          );
          return result;
        }
        hasMore = dateRecords < totalCount;
        if (hasMore && details.length === 0)
          throw new SmsDeliveryError('TRANSIENT', 'ALIYUN_INCONSISTENT_QUERY_RESPONSE');
        currentPage += 1;
      }
    }
    if (lastRequestId === null)
      throw new SmsDeliveryError('TRANSIENT', 'ALIYUN_MALFORMED_QUERY_RESPONSE');
    const result: SmsReceiptResult = {
      status: 'PENDING',
      requestId: lastRequestId,
      ...(input.receipt === undefined ? {} : { receipt: input.receipt }),
    };
    this.logReceipt(input, result, 'NOT_FOUND');
    return result;
  }

  private logReceipt(input: SmsSendInput, result: SmsReceiptResult, code: string): void {
    this.log({
      event: 'sms.reconcile',
      phone: maskPhone(input.phoneE164),
      requestId: result.requestId,
      ...(result.receipt === undefined ? {} : { receipt: result.receipt }),
      code,
    });
  }

  private assertApproved(input: SmsSendInput): void {
    if (
      !this.config.approvedSigns.includes(input.signName) ||
      !this.config.approvedTemplateCodes.includes(input.templateCode)
    )
      throw new SmsDeliveryError(
        'PERMANENT',
        'SMS_CONFIGURATION_NOT_APPROVED',
        'SMS_CONFIGURATION_NOT_APPROVED',
        'NOT_ATTEMPTED',
      );
  }
}

interface AliyunSmsSenderLimits {
  maxPages?: number;
  maxRecords?: number;
  requestTimeoutMs?: number;
  reconcileTimeoutMs?: number;
}

function withDeadline<T>(
  action: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
  parentSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      parentSignal?.removeEventListener('abort', parentAbort);
      complete();
    };
    const failTimeout = () => {
      finish(() => {
        reject(new SmsDeliveryError('TRANSIENT', timeoutCode));
      });
      controller.abort();
    };
    const parentAbort = () => {
      failTimeout();
    };
    const timer = setTimeout(failTimeout, timeoutMs);
    if (parentSignal?.aborted === true) {
      failTimeout();
      return;
    }
    parentSignal?.addEventListener('abort', parentAbort, { once: true });
    void action(controller.signal).then(
      (value) => {
        finish(() => {
          resolve(value);
        });
      },
      (error: unknown) => {
        finish(() => {
          reject(error instanceof Error ? error : new Error('SMS_PROVIDER_FAILURE'));
        });
      },
    );
  });
}

function reconciliationDates(value: Date, actualSendDate: string): string[] {
  return [
    ...new Set([
      actualSendDate,
      ...[1, -1].map((days) => formatSendDate(new Date(value.getTime() + days * 86_400_000))),
    ]),
  ];
}

function formatSendDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

function parseTotalCount(value: string | undefined): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isAliyunDetails(
  value: unknown,
): value is { outId?: string; sendStatus?: unknown; errCode?: unknown }[] {
  return (
    Array.isArray(value) &&
    value.every(
      (detail: unknown) =>
        typeof detail === 'object' &&
        detail !== null &&
        (!('outId' in detail) || detail.outId === undefined || typeof detail.outId === 'string'),
    )
  );
}

export function maskPhone(phone: string): string {
  if (/^\+86\d{11}$/.test(phone)) return `${phone.slice(0, 3)}*******${phone.slice(-3)}`;
  if (phone.length <= 6) return '***';
  return `${phone.slice(0, 3)}${'*'.repeat(Math.max(3, phone.length - 6))}${phone.slice(-3)}`;
}

function mapProviderFailure(error: unknown): SmsDeliveryError {
  if (error instanceof SmsDeliveryError) return error;
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'ALIYUN_TRANSPORT_ERROR';
  if (
    [
      'InvalidAccessKeyId.NotFound',
      'Forbidden.RAM',
      'isv.SMS_SIGNATURE_ILLEGAL',
      'isv.SMS_TEMPLATE_ILLEGAL',
      'isv.MOBILE_NUMBER_ILLEGAL',
    ].includes(code)
  )
    return new SmsDeliveryError('PERMANENT', code);
  return new SmsDeliveryError('TRANSIENT', code);
}

function providerCodeError(code: string, message?: string): SmsDeliveryError {
  const permanent = /SIGNATURE|TEMPLATE|MOBILE|PARAMETER|BLACK_KEY/i.test(code);
  return new SmsDeliveryError(
    permanent ? 'PERMANENT' : 'TRANSIENT',
    code,
    message ?? code,
    'NOT_ATTEMPTED',
  );
}
