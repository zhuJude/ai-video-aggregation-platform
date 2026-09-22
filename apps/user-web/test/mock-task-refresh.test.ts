import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const requireMutable = vi.hoisted(() => vi.fn());

vi.mock('../lib/auth/server-session', () => {
  class AuthenticationRequiredError extends Error {}
  class SessionRefreshRequiredError extends Error {}
  return {
    AuthenticationRequiredError,
    SessionRefreshRequiredError,
    authenticatedGatewayFetch: vi.fn(),
    requireMutableAuthenticatedServerSession: requireMutable,
  };
});

beforeEach(async () => {
  process.env.USER_WEB_STUDIO_MODE = 'mock';
  const { SessionRefreshRequiredError } = await import('../lib/auth/server-session');
  requireMutable.mockRejectedValue(new SessionRefreshRequiredError());
});

afterEach(() => {
  delete process.env.USER_WEB_STUDIO_MODE;
  vi.clearAllMocks();
});

it('returns a typed refresh requirement from the mock poll boundary', async () => {
  const { GET } = await import('../app/api/tasks/[id]/route');
  const response = await GET(new Request('https://app.example/api/tasks/task-1'), {
    params: Promise.resolve({ id: 'task-1' }),
  });

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ code: 'SESSION_REFRESH_REQUIRED' });
  expect(requireMutable).toHaveBeenCalledTimes(1);
});

it('returns the same typed refresh requirement from the mock SSE boundary', async () => {
  const { GET } = await import('../app/api/tasks/[id]/events/route');
  const response = await GET(new Request('https://app.example/api/tasks/task-1/events'), {
    params: Promise.resolve({ id: 'task-1' }),
  });

  expect(response.status).toBe(401);
  await expect(response.json()).resolves.toEqual({ code: 'SESSION_REFRESH_REQUIRED' });
  expect(requireMutable).toHaveBeenCalledTimes(1);
});
