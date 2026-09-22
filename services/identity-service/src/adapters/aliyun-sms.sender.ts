import type {
  AliyunSmsConfigurationProvider,
  KmsReferencedConfigResolver,
  SmsSender,
} from '../ports/sms-sender.js';
import { assertVersionedKmsReference } from '../domain/kms-reference.js';

export const ALIYUN_SMS_SDK_COMPATIBILITY = {
  packageName: '@alicloud/dysmsapi20170525',
  version: '4.6.0',
} as const;

/** Structural subset of @alicloud/dysmsapi20170525 SendSmsRequest used by this adapter. */
export interface AliyunSendSmsRequest {
  phoneNumbers: string;
  signName: string;
  templateCode: string;
  templateParam: string;
}

/** Structural subset of the official v4.6.0 SendSmsResponse. */
export interface AliyunSendSmsResponse {
  body?: {
    bizId?: string;
    code?: string;
    message?: string;
    requestId?: string;
  };
  statusCode?: number;
}

export interface AliyunSmsClient {
  sendSms(request: AliyunSendSmsRequest): Promise<AliyunSendSmsResponse>;
}

export interface AliyunSmsClientProviderOptions {
  credentialKind: 'ecs_ram_role' | 'oidc_role_arn';
  roleKmsReference: string;
  sdkCompatibility: typeof ALIYUN_SMS_SDK_COMPATIBILITY;
}

/**
 * Infrastructure owns this boundary. Its v4.6.0 implementation must resolve the required role
 * reference through KMS, create the official client with ECS RAM-role or OIDC role credentials,
 * and wrap `Client.sendSms(new SendSmsRequest(input))` behind this narrow shape.
 * AccessKey ID/secret configuration is intentionally absent from the interface.
 */
export interface AliyunSmsClientProvider {
  getClient(options: AliyunSmsClientProviderOptions): Promise<AliyunSmsClient>;
}

export class AliyunSmsSender implements SmsSender {
  constructor(
    private readonly clientProvider: AliyunSmsClientProvider,
    private readonly configurationProvider: AliyunSmsConfigurationProvider,
    private readonly kmsConfigResolver: KmsReferencedConfigResolver,
  ) {}

  async sendCode(phoneE164: string, code: string): Promise<void> {
    if (!/^\+861[3-9]\d{9}$/.test(phoneE164)) throw stableError('INVALID_PHONE');
    if (!/^\d{6}$/.test(code)) throw stableError('INVALID_SMS_CODE');

    const references = await this.configurationProvider.getReferences();
    const credentialKind = validateConfigurationReferences(references);
    const [signName, templateCode] = await Promise.all([
      this.kmsConfigResolver.resolveValue(references.signNameKmsReference),
      this.kmsConfigResolver.resolveValue(references.templateCodeKmsReference),
    ]);
    validateResolvedConfiguration(signName, templateCode);
    const providerOptions: AliyunSmsClientProviderOptions = {
      credentialKind,
      roleKmsReference: references.roleKmsReference,
      sdkCompatibility: ALIYUN_SMS_SDK_COMPATIBILITY,
    };
    const client = await this.clientProvider.getClient(providerOptions);
    const response = await client.sendSms({
      phoneNumbers: phoneE164.slice(3),
      signName,
      templateCode,
      templateParam: JSON.stringify({ code }),
    });
    if (response.body?.code !== 'OK') throw stableError('ALIYUN_SMS_SEND_FAILED');
  }
}

function validateConfigurationReferences(references: {
  credentialKind: string;
  signNameKmsReference: string;
  templateCodeKmsReference: string;
  roleKmsReference: string;
}): 'ecs_ram_role' | 'oidc_role_arn' {
  if (
    references.credentialKind !== 'ecs_ram_role' &&
    references.credentialKind !== 'oidc_role_arn'
  ) {
    throw stableError('ALIYUN_SMS_UNSUPPORTED_CREDENTIAL_KIND');
  }
  for (const reference of [
    references.signNameKmsReference,
    references.templateCodeKmsReference,
    references.roleKmsReference,
  ]) {
    assertVersionedKmsReference(reference, 'ALIYUN_SMS_KMS_REFERENCES_REQUIRED');
  }
  return references.credentialKind;
}

function validateResolvedConfiguration(signName: string, templateCode: string): void {
  if (signName.trim().length === 0 || templateCode.trim().length === 0) {
    throw new Error('ALIYUN_SMS_CONFIGURATION_REQUIRED');
  }
}

function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
