import { describe, expect, it } from 'vitest';

describe('Prisma datasource configuration', () => {
  it('omits the datasource URL when DATABASE_URL is absent', async () => {
    const config = await import('../prisma.config.js');

    expect(config.resolveDatasource).toBeTypeOf('function');
    expect(config.resolveDatasource({})).toEqual({});
  });

  it('uses DATABASE_URL when it is present', async () => {
    const config = await import('../prisma.config.js');
    const url = 'postgresql://configuration.invalid/generation';

    expect(config.resolveDatasource({ DATABASE_URL: url })).toEqual({ url });
  });
});
