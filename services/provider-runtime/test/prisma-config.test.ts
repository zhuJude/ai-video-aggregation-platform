import { describe, expect, it, vi } from 'vitest';

describe('Prisma configuration', () => {
  it('does not invent a datasource URL when DATABASE_URL is absent', async () => {
    vi.resetModules();
    const { resolveDatasource } = await import('../prisma.config.js');
    expect(resolveDatasource({})).toEqual({});
  });

  it('uses only the explicitly provided provider-runtime datasource URL', async () => {
    vi.resetModules();
    const { resolveDatasource } = await import('../prisma.config.js');
    expect(resolveDatasource({ DATABASE_URL: 'postgresql://runtime.invalid/provider' })).toEqual({
      url: 'postgresql://runtime.invalid/provider',
    });
  });

  it('provides a reserved, non-routable schema-tools provider hint', async () => {
    vi.resetModules();
    const { default: configuration } = await import('../prisma.schema-tools.config.js');
    expect(configuration.datasource).toEqual({
      url: 'postgresql://schema-tools.invalid/provider-runtime',
    });
  });
});
