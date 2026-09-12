import { fileURLToPath } from 'node:url';

export default {
  resolve: {
    alias: {
      'server-only': fileURLToPath(new URL('./test/server-only.mock.ts', import.meta.url)),
    },
  },
};
