import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Provider hint for schema-to-schema diff only; this reserved domain is never contacted.
    url: 'postgresql://schema-tools.invalid/generation',
  },
});
