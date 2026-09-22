import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('real PostgreSQL gate', () => {
  it('requires a dedicated notification test database URL', () => {
    const script = readFileSync(
      fileURLToPath(new URL('../scripts/test-postgresql.mjs', import.meta.url)),
      'utf8',
    );
    expect(script).toContain('NOTIFICATION_TEST_DATABASE_URL is required');
    expect(script).not.toContain('DATABASE_URL ||');
    expect(script).toContain("import.meta.resolve('vitest/package.json')");
    expect(script).not.toContain("import.meta.resolve('vitest/vitest.mjs')");
  });
});
