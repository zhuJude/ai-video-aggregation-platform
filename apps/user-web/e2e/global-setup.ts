import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

const namespace = '0198f4d4-21c2-7b7d-8a03-08a0da2ae2e1';

export default async function globalSetup(): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const target = resolve(temporaryRoot, `ai-video-user-web-commerce-mock-v1-test-${namespace}`);
  if (
    dirname(target) !== temporaryRoot ||
    basename(target) !== `ai-video-user-web-commerce-mock-v1-test-${namespace}`
  ) {
    throw new Error('REFUSING_UNSAFE_E2E_STORE_RESET');
  }
  await rm(target, { force: true, recursive: true });
}
