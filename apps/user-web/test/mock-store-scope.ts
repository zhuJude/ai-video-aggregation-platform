import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

const PREFIX = 'ai-video-user-web-commerce-mock-v1-test-';

export function createMockStoreTestScope() {
  const namespace = randomUUID();
  const temporaryRoot = resolve(tmpdir());
  const expectedName = `${PREFIX}${namespace}`;
  const root = resolve(temporaryRoot, expectedName);
  if (dirname(root) !== temporaryRoot || basename(root) !== expectedName) {
    throw new Error('INVALID_TEST_STORE_SCOPE');
  }
  return {
    root,
    install() {
      process.env.USER_WEB_COMMERCE_MOCK_TEST_NAMESPACE = namespace;
    },
    async cleanup() {
      if (dirname(root) !== temporaryRoot || basename(root) !== expectedName) {
        throw new Error('INVALID_TEST_STORE_SCOPE');
      }
      await rm(root, { force: true, recursive: true });
    },
  };
}
