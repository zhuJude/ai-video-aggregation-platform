import '@testing-library/jest-dom/vitest';

import { render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const readState = vi.hoisted(() => vi.fn());
const redirectTo = vi.hoisted(() =>
  vi.fn((path: string) => {
    throw new Error(`NEXT_REDIRECT:${path}`);
  }),
);

vi.mock('../lib/auth/server-session', () => ({
  readAuthenticatedServerSessionState: readState,
}));
vi.mock('next/navigation', () => ({ redirect: redirectTo }));
vi.mock('../components/studio/studio-workspace', () => ({
  StudioWorkspace: () => <div>真实工作台</div>,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

it('renders Studio only for an active session', async () => {
  readState.mockResolvedValue({
    kind: 'active',
    session: { ownerId: '0198f4d4-21c2-7b7d-8a03-08a0da2a7401' },
  });
  const { default: StudioPage } = await import('../app/studio/page');
  render(await StudioPage({ searchParams: Promise.resolve({}) }));
  expect(screen.getByText('真实工作台')).toBeVisible();
  expect(redirectTo).not.toHaveBeenCalled();
});

it('routes a refreshable session through the strict same-origin trampoline', async () => {
  readState.mockResolvedValue({ kind: 'needs-refresh' });
  const { default: StudioPage } = await import('../app/studio/page');
  const draft = '0198f4d4-21c2-7b7d-8a03-08a0da2a7402';
  await expect(StudioPage({ searchParams: Promise.resolve({ draft }) })).rejects.toThrow(
    `NEXT_REDIRECT:/auth/session/refresh?returnTo=${encodeURIComponent(`/studio?draft=${draft}`)}`,
  );
});

it('routes an invalid session to login without reflecting an unsafe draft', async () => {
  readState.mockResolvedValue({ kind: 'invalid' });
  const { default: StudioPage } = await import('../app/studio/page');
  await expect(
    StudioPage({ searchParams: Promise.resolve({ draft: '//evil.example/%0d%0a' }) }),
  ).rejects.toThrow('NEXT_REDIRECT:/login?returnTo=%2Fstudio');
});
