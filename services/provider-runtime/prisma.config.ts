import { defineConfig } from 'prisma/config';

export function resolveDatasource(
  environment: Readonly<Record<string, string | undefined>>,
): { readonly url: string } | Record<string, never> {
  const url = environment.DATABASE_URL;
  return url === undefined ? {} : { url };
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: resolveDatasource(process.env),
});
