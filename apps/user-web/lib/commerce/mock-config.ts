import 'server-only';

export function requireMockCommerceSigningKey(): Buffer {
  if (process.env.USER_WEB_COMMERCE_MODE !== 'mock') {
    throw new Error('COMMERCE_SERVICE_UNAVAILABLE');
  }
  const encoded = process.env.USER_WEB_COMMERCE_MOCK_SIGNING_KEY;
  if (!encoded || !/^[A-Za-z0-9_-]{43}$/.test(encoded)) {
    throw new Error('COMMERCE_MOCK_SIGNING_KEY_UNAVAILABLE');
  }
  const key = Buffer.from(encoded, 'base64url');
  if (key.length !== 32 || key.toString('base64url') !== encoded) {
    throw new Error('COMMERCE_MOCK_SIGNING_KEY_UNAVAILABLE');
  }
  return key;
}

export function requireMockCommerce(): void {
  void requireMockCommerceSigningKey();
}
