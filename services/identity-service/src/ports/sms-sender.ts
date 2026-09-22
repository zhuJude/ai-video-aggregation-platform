export interface SmsSender {
  sendCode(phoneE164: string, code: string): Promise<void>;
}

export interface AliyunSmsConfigurationReferences {
  credentialKind: string;
  signNameKmsReference: string;
  templateCodeKmsReference: string;
  roleKmsReference: string;
}

export interface AliyunSmsConfigurationProvider {
  getReferences(): Promise<AliyunSmsConfigurationReferences>;
}

export interface KmsReferencedConfigResolver {
  resolveValue(kmsReference: string): Promise<string>;
}
