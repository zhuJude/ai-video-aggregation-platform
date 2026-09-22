export function resolveIdentityTestDatabaseUrl(
  environment: Record<string, string | undefined>,
): string | null {
  const configured = environment['IDENTITY_TEST_DATABASE_URL'];
  if (!configured) return null;

  let target: URL;
  try {
    target = new URL(configured);
  } catch {
    throw new Error('UNSAFE_IDENTITY_TEST_DATABASE_URL');
  }
  if (target.protocol !== 'postgresql:' && target.protocol !== 'postgres:') {
    throw new Error('UNSAFE_IDENTITY_TEST_DATABASE_URL');
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!/^identity_test(?:_[a-z0-9_-]+)?$/.test(databaseName)) {
    throw new Error('UNSAFE_IDENTITY_TEST_DATABASE_URL');
  }
  return configured;
}
