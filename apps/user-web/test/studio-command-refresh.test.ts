import { beforeEach, expect, it, vi } from 'vitest';

const actions = vi.hoisted(() => ({
  create: vi.fn(),
  capability: vi.fn(),
  models: vi.fn(),
  providers: vi.fn(),
  quote: vi.fn(),
  smartCapability: vi.fn(),
}));
const refresh = vi.hoisted(() => vi.fn());

vi.mock('../app/studio/actions', () => ({
  createStudioTaskAction: actions.create,
  getStudioCapabilityAction: actions.capability,
  getSmartStudioCapabilityAction: actions.smartCapability,
  listStudioModelsAction: actions.models,
  listStudioProvidersAction: actions.providers,
  quoteStudioTaskAction: actions.quote,
}));
vi.mock('../lib/auth/client-session', () => ({ coordinateSessionRefresh: refresh }));

beforeEach(() => {
  vi.clearAllMocks();
  refresh.mockResolvedValue(true);
});

it('refreshes once and retries task creation with the identical quote snapshot and idempotency key', async () => {
  const accepted = {
    taskId: '0198f4d4-21c2-7b7d-8a03-08a0da2a7711',
    status: 'QUEUED',
  } as const;
  actions.create
    .mockResolvedValueOnce({ ok: false, outcome: 'SESSION_REFRESH_REQUIRED' })
    .mockResolvedValueOnce({ ok: true, data: accepted });
  const request = {
    quoteId: '0198f4d4-21c2-7b7d-8a03-08a0da2a7611',
    capabilityVersion: 'cap-text-v4',
    parameters: { prompt: '日落海边公路', duration: 5, aspectRatio: '16:9' },
    quotedPoints: '240',
  };
  const idempotencyKey = '0198f4d4-21c2-7b7d-8a03-08a0da2a7511';
  const { clientStudioGateway } = await import('../lib/studio/client-gateway');

  await expect(clientStudioGateway.createTask(request, { idempotencyKey })).resolves.toEqual(
    accepted,
  );
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(actions.create).toHaveBeenCalledTimes(2);
  expect(actions.create).toHaveBeenNthCalledWith(1, request, idempotencyKey);
  expect(actions.create).toHaveBeenNthCalledWith(2, request, idempotencyKey);
});

it('refreshes a quote request once and fails definitively when the session cannot recover', async () => {
  actions.quote.mockResolvedValue({ ok: false, outcome: 'SESSION_REFRESH_REQUIRED' });
  refresh.mockResolvedValue(false);
  const request = {
    routing: {
      kind: 'SMART' as const,
      preferences: {
        generationMode: 'TEXT_TO_VIDEO' as const,
        quality: 'BALANCED' as const,
        speed: 'BALANCED' as const,
        budgetPoints: 300,
        goal: '',
      },
    },
    capabilityVersion: 'cap-text-v4',
    parameters: { prompt: '日落海边公路', duration: 5, aspectRatio: '16:9' },
  };
  const { clientStudioGateway } = await import('../lib/studio/client-gateway');

  await expect(clientStudioGateway.quote(request)).rejects.toMatchObject({
    message: 'LOGIN_REQUIRED',
    outcome: 'DEFINITIVE_FAILURE',
  });
  expect(actions.quote).toHaveBeenCalledTimes(1);
});
