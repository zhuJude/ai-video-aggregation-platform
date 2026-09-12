import { fileURLToPath } from 'node:url';

export default {
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./test/server-only.mock.ts', import.meta.url)),
    },
  },
  // The commerce integration suite intentionally exercises one fixed, cross-runtime local store.
  // Serial files prevent another test file from deleting a lock it did not create while simulating
  // crash recovery; production concurrency remains covered inside the store-focused tests.
  test: {
    fileParallelism: false,
  },
};
