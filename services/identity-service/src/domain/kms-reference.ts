const VERSIONED_KMS_REFERENCE = /^kms:\/\/[a-z0-9][a-z0-9/_-]*#version=([A-Za-z0-9._-]+)$/;
const FLOATING_VERSION_ALIASES = new Set(['latest', 'current', 'active']);

export function assertVersionedKmsReference(
  reference: string,
  errorCode = 'INVALID_VERSIONED_KMS_REFERENCE',
): void {
  versionedKmsReferenceVersion(reference, errorCode);
}

export function versionedKmsReferenceVersion(
  reference: string,
  errorCode = 'INVALID_VERSIONED_KMS_REFERENCE',
): string {
  const match = VERSIONED_KMS_REFERENCE.exec(reference);
  const rawVersion = match?.[1];
  if (!rawVersion || FLOATING_VERSION_ALIASES.has(rawVersion.toLowerCase())) {
    throw Object.assign(new Error(errorCode), { code: errorCode });
  }
  return rawVersion;
}
