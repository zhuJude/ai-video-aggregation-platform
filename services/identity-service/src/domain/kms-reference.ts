const VERSIONED_KMS_REFERENCE = /^kms:\/\/[a-z0-9][a-z0-9/_-]*#version=([A-Za-z0-9._-]+)$/;
const FLOATING_VERSION_ALIASES = new Set(['latest', 'current', 'active']);

export function assertVersionedKmsReference(
  reference: string,
  errorCode = 'INVALID_VERSIONED_KMS_REFERENCE',
): void {
  const match = VERSIONED_KMS_REFERENCE.exec(reference);
  const version = match?.[1]?.toLowerCase();
  if (!version || FLOATING_VERSION_ALIASES.has(version)) {
    throw Object.assign(new Error(errorCode), { code: errorCode });
  }
}
