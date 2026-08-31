import '@testing-library/jest-dom/vitest';
import type * as NextNavigation from 'next/navigation';

import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

vi.mock('next/navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof NextNavigation>();
  return { ...actual, useRouter: () => ({ refresh: vi.fn() }) };
});

afterEach(() => {
  cleanup();
});
