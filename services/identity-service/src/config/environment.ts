import { assertVersionedKmsReference } from '../domain/kms-reference.js';

export interface IdentityEnvironment {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly smsChallengeKeyReference: string;
  readonly privacyKeyReference: string;
  readonly previousPrivacyKeyReferences: readonly string[];
  readonly jwtSigningKeyReference: string;
  readonly smsSignNameReference: string;
  readonly smsTemplateCodeReference: string;
  readonly smsRoleReference: string;
  readonly smsCredentialKind: 'ecs_ram_role' | 'oidc_role_arn';
  readonly readinessTimeoutMs: number;
  readonly readinessAbortGraceMs: number;
  readonly databaseOperationTimeoutMs: number;
  readonly redisOperationTimeoutMs: number;
  readonly eventLoopStallThresholdMs: number;
}

export function parseIdentityEnvironment(env: NodeJS.ProcessEnv): IdentityEnvironment {
  rejectAccessKeys(env);
  const result: IdentityEnvironment = {
    host: optionalHost(env['IDENTITY_HOST']),
    port: integer(env['IDENTITY_PORT'] ?? '3001', 1, 65_535, 'INVALID_IDENTITY_PORT'),
    databaseUrl: serviceUrl(
      required(env, 'IDENTITY_DATABASE_URL'),
      ['postgres:', 'postgresql:'],
      'INVALID_IDENTITY_DATABASE_URL',
    ),
    redisUrl: serviceUrl(
      required(env, 'IDENTITY_REDIS_URL'),
      ['redis:', 'rediss:'],
      'INVALID_IDENTITY_REDIS_URL',
    ),
    smsChallengeKeyReference: kms(required(env, 'IDENTITY_SMS_CHALLENGE_KMS_KEY_REF')),
    privacyKeyReference: kms(required(env, 'IDENTITY_PRIVACY_KMS_KEY_REF')),
    previousPrivacyKeyReferences: references(env['IDENTITY_PREVIOUS_PRIVACY_KMS_KEY_REFS']),
    jwtSigningKeyReference: kms(required(env, 'IDENTITY_JWT_SIGNING_KMS_KEY_REF')),
    smsSignNameReference: kms(required(env, 'IDENTITY_SMS_SIGN_NAME_KMS_REF')),
    smsTemplateCodeReference: kms(required(env, 'IDENTITY_SMS_TEMPLATE_KMS_REF')),
    smsRoleReference: kms(required(env, 'IDENTITY_SMS_ROLE_KMS_REF')),
    smsCredentialKind: credentialKind(required(env, 'IDENTITY_SMS_CREDENTIAL_KIND')),
    readinessTimeoutMs: integer(
      env['IDENTITY_READINESS_TIMEOUT_MS'] ?? '1000',
      10,
      10_000,
      'INVALID_READINESS_TIMEOUT',
    ),
    readinessAbortGraceMs: integer(
      env['IDENTITY_READINESS_ABORT_GRACE_MS'] ?? '500',
      10,
      10_000,
      'INVALID_READINESS_ABORT_GRACE',
    ),
    databaseOperationTimeoutMs: integer(
      env['IDENTITY_DATABASE_OPERATION_TIMEOUT_MS'] ?? '5000',
      100,
      60_000,
      'INVALID_DATABASE_OPERATION_TIMEOUT',
    ),
    redisOperationTimeoutMs: integer(
      env['IDENTITY_REDIS_OPERATION_TIMEOUT_MS'] ?? '5000',
      100,
      60_000,
      'INVALID_REDIS_OPERATION_TIMEOUT',
    ),
    eventLoopStallThresholdMs: integer(
      env['IDENTITY_EVENT_LOOP_STALL_MS'] ?? '250',
      10,
      10_000,
      'INVALID_STALL_THRESHOLD',
    ),
  };
  return Object.freeze(result);
}
function credentialKind(value: string): 'ecs_ram_role' | 'oidc_role_arn' {
  if (value !== 'ecs_ram_role' && value !== 'oidc_role_arn')
    throw stableError('INVALID_SMS_CREDENTIAL_KIND');
  return value;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw stableError(`MISSING_${name}`);
  return value.trim();
}
function kms(value: string): string {
  assertVersionedKmsReference(value, 'UNVERSIONED_KMS_REFERENCE');
  return value;
}
function references(value: string | undefined): readonly string[] {
  if (!value) return Object.freeze([]);
  const values = value.split(',').map((item) => kms(item.trim()));
  if (values.some((item) => !item) || new Set(values).size !== values.length)
    throw stableError('INVALID_KMS_KEYRING');
  return Object.freeze(values);
}
function serviceUrl(value: string, protocols: readonly string[], code: string): string {
  try {
    const url = new URL(value);
    if (!protocols.includes(url.protocol) || !url.hostname) throw new Error();
    return value;
  } catch {
    throw stableError(code);
  }
}
function optionalHost(value: string | undefined): string {
  const host = value?.trim() || '0.0.0.0';
  if (!/^[A-Za-z0-9:.-]{1,255}$/.test(host)) throw stableError('INVALID_IDENTITY_HOST');
  return host;
}
function integer(value: string, min: number, max: number, code: string): number {
  if (!/^\d+$/.test(value)) throw stableError(code);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw stableError(code);
  return parsed;
}
function rejectAccessKeys(env: NodeJS.ProcessEnv): void {
  for (const name of [
    'ALIBABA_CLOUD_ACCESS_KEY_ID',
    'ALIBABA_CLOUD_ACCESS_KEY_SECRET',
    'ALIYUN_ACCESS_KEY_ID',
    'ALIYUN_ACCESS_KEY_SECRET',
  ])
    if (env[name]) throw stableError('STATIC_ACCESS_KEYS_FORBIDDEN');
}
function stableError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
