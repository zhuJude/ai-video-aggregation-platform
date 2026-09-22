export function resolveIamTestDatabaseUrl(
  environment: Record<string, string | undefined>,
): string | null {
  const configured = environment['IAM_TEST_DATABASE_URL'];
  if (!configured) return null;
  const target = parseUrl(configured, 'UNSAFE_IAM_TEST_DATABASE_URL');
  if (target.protocol !== 'postgresql:' && target.protocol !== 'postgres:') {
    throw new Error('UNSAFE_IAM_TEST_DATABASE_URL');
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (!/^iam_test(?:_[a-z0-9_-]+)?$/.test(databaseName)) {
    throw new Error('UNSAFE_IAM_TEST_DATABASE_URL');
  }
  return configured;
}

export function resolveIamTestRedisUrl(
  environment: Record<string, string | undefined>,
): string | null {
  const configured = environment['IAM_TEST_REDIS_URL'];
  if (!configured) return null;
  const target = parseUrl(configured, 'UNSAFE_IAM_TEST_REDIS_URL');
  if (target.protocol !== 'redis:' && target.protocol !== 'rediss:') {
    throw new Error('UNSAFE_IAM_TEST_REDIS_URL');
  }
  const databaseNumber = Number(target.pathname.replace(/^\//, ''));
  if (!Number.isInteger(databaseNumber) || databaseNumber < 1 || databaseNumber > 15) {
    throw new Error('UNSAFE_IAM_TEST_REDIS_URL');
  }
  return configured;
}

function parseUrl(value: string, errorCode: string): URL {
  try {
    return new URL(value);
  } catch {
    throw new Error(errorCode);
  }
}
