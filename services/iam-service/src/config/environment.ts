export interface IamEnvironment {
  readonly host: string;
  readonly port: number;
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly signingKeyReference: string;
  readonly totpKeyReference: string;
  readonly previousSigningKeyReferences: readonly string[];
  readonly previousTotpKeyReferences: readonly string[];
  readonly loginHmacKeyReference: string;
  readonly previousLoginHmacKeyReferences: readonly string[];
  readonly recoveryPepperKeyReference: string;
  readonly previousRecoveryPepperKeyReferences: readonly string[];
  readonly kmsIdentity:
    | { readonly mode: 'ecs_ram_role'; readonly roleName: string }
    | {
        readonly mode: 'oidc_role_arn';
        readonly roleArn: string;
        readonly oidcProviderArn: string;
        readonly clientId: string;
      };
  readonly dummyPasswordHash: string;
  readonly bootstrapProofReference: string;
  readonly readinessTimeoutMs: number;
  readonly readinessAbortGraceMs: number;
  readonly databaseOperationTimeoutMs: number;
  readonly redisOperationTimeoutMs: number;
  readonly eventLoopStallThresholdMs: number;
  readonly pendingCleanupIntervalMs: number;
  readonly pendingCleanupBatchSize: number;
}
const KMS = /^acs:kms:[^\s:]+:[^\s:]+:key\/[^\s:]+:version\/[A-Za-z0-9._-]+$/;
export function parseIamEnvironment(env: NodeJS.ProcessEnv): IamEnvironment {
  rejectAccessKeys(env);
  return Object.freeze({
    host: host(env['IAM_HOST']),
    port: integer(env['IAM_PORT'] ?? '3002', 1, 65_535, 'INVALID_IAM_PORT'),
    databaseUrl: url(
      required(env, 'IAM_DATABASE_URL'),
      ['postgres:', 'postgresql:'],
      'INVALID_IAM_DATABASE_URL',
    ),
    redisUrl: url(required(env, 'IAM_REDIS_URL'), ['redis:', 'rediss:'], 'INVALID_IAM_REDIS_URL'),
    signingKeyReference: kms(required(env, 'IAM_JWT_SIGNING_KMS_KEY_REF')),
    previousSigningKeyReferences: refs(env['IAM_PREVIOUS_JWT_SIGNING_KMS_KEY_REFS']),
    totpKeyReference: kms(required(env, 'IAM_TOTP_KMS_KEY_REF')),
    previousTotpKeyReferences: refs(env['IAM_PREVIOUS_TOTP_KMS_KEY_REFS']),
    loginHmacKeyReference: kms(required(env, 'IAM_LOGIN_HMAC_KMS_KEY_REF')),
    previousLoginHmacKeyReferences: refs(env['IAM_PREVIOUS_LOGIN_HMAC_KMS_KEY_REFS']),
    recoveryPepperKeyReference: kms(required(env, 'IAM_RECOVERY_PEPPER_KMS_KEY_REF')),
    previousRecoveryPepperKeyReferences: refs(env['IAM_PREVIOUS_RECOVERY_PEPPER_KMS_KEY_REFS']),
    kmsIdentity: kmsIdentity(env),
    dummyPasswordHash: required(env, 'IAM_DUMMY_PASSWORD_HASH'),
    bootstrapProofReference: kms(required(env, 'IAM_BOOTSTRAP_PROOF_KMS_REF')),
    readinessTimeoutMs: integer(
      env['IAM_READINESS_TIMEOUT_MS'] ?? '1000',
      10,
      10_000,
      'INVALID_READINESS_TIMEOUT',
    ),
    readinessAbortGraceMs: integer(
      env['IAM_READINESS_ABORT_GRACE_MS'] ?? '500',
      10,
      10_000,
      'INVALID_READINESS_ABORT_GRACE',
    ),
    databaseOperationTimeoutMs: integer(
      env['IAM_DATABASE_OPERATION_TIMEOUT_MS'] ?? '5000',
      100,
      60_000,
      'INVALID_DATABASE_OPERATION_TIMEOUT',
    ),
    redisOperationTimeoutMs: integer(
      env['IAM_REDIS_OPERATION_TIMEOUT_MS'] ?? '5000',
      100,
      60_000,
      'INVALID_REDIS_OPERATION_TIMEOUT',
    ),
    eventLoopStallThresholdMs: integer(
      env['IAM_EVENT_LOOP_STALL_MS'] ?? '250',
      10,
      10_000,
      'INVALID_STALL_THRESHOLD',
    ),
    pendingCleanupIntervalMs: integer(
      env['IAM_PENDING_CLEANUP_INTERVAL_MS'] ?? '60000',
      1_000,
      3_600_000,
      'INVALID_PENDING_CLEANUP_INTERVAL',
    ),
    pendingCleanupBatchSize: integer(
      env['IAM_PENDING_CLEANUP_BATCH_SIZE'] ?? '100',
      1,
      500,
      'INVALID_PENDING_CLEANUP_BATCH',
    ),
  });
}
function kmsIdentity(env: NodeJS.ProcessEnv): IamEnvironment['kmsIdentity'] {
  const mode = required(env, 'IAM_KMS_IDENTITY_MODE');
  if (mode === 'ecs_ram_role') {
    const roleName = required(env, 'IAM_KMS_ECS_RAM_ROLE_NAME');
    if (!/^[A-Za-z0-9.@_-]{1,64}$/.test(roleName)) throw stableError('INVALID_KMS_IDENTITY');
    return Object.freeze({ mode, roleName });
  }
  if (mode === 'oidc_role_arn') {
    const roleArn = required(env, 'IAM_KMS_OIDC_ROLE_ARN');
    const oidcProviderArn = required(env, 'IAM_KMS_OIDC_PROVIDER_ARN');
    const clientId = required(env, 'IAM_KMS_OIDC_CLIENT_ID');
    if (
      !/^acs:ram::[0-9]+:role\/[A-Za-z0-9._/-]+$/.test(roleArn) ||
      !/^acs:ram::[0-9]+:oidc-provider\/[A-Za-z0-9._/-]+$/.test(oidcProviderArn) ||
      !/^[A-Za-z0-9._:@/-]{1,128}$/.test(clientId)
    )
      throw stableError('INVALID_KMS_IDENTITY');
    return Object.freeze({ mode, roleArn, oidcProviderArn, clientId });
  }
  throw stableError('UNSUPPORTED_KMS_IDENTITY');
}
function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value?.trim()) throw stableError(`MISSING_${name}`);
  return value.trim();
}
function kms(value: string): string {
  if (!KMS.test(value)) throw stableError('UNVERSIONED_KMS_REFERENCE');
  return value;
}
function refs(value: string | undefined): readonly string[] {
  if (!value) return Object.freeze([]);
  const values = value.split(',').map((item) => kms(item.trim()));
  if (new Set(values).size !== values.length) throw stableError('INVALID_KMS_KEYRING');
  return Object.freeze(values);
}
function url(value: string, protocols: readonly string[], code: string): string {
  try {
    const parsed = new URL(value);
    if (!protocols.includes(parsed.protocol) || !parsed.hostname) throw new Error();
    return value;
  } catch {
    throw stableError(code);
  }
}
function host(value: string | undefined): string {
  const result = value?.trim() || '0.0.0.0';
  if (!/^[A-Za-z0-9:.-]{1,255}$/.test(result)) throw stableError('INVALID_IAM_HOST');
  return result;
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
