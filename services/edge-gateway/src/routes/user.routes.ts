import type { UserSubject } from '../auth/subject.js';
import type { ServiceRequestContext } from '../clients/service-client.js';

export const USER_ROUTE_TABLE = [
  { external: '/v1/models', internal: '/v1/models', method: 'GET', service: 'catalog' },
  { external: '/v1/dashboard', internal: null, method: 'GET', service: 'bff' },
  {
    external: '/v1/tasks',
    idempotency: 'task-create',
    internal: '/v1/tasks',
    method: 'POST',
    service: 'generation',
  },
] as const;

export interface DashboardCardClient {
  get(subject: UserSubject, context: ServiceRequestContext): Promise<object>;
}

export interface UserBffClients {
  readonly messages: DashboardCardClient;
  readonly tasks: DashboardCardClient;
  readonly wallet: DashboardCardClient;
}

function settledValue(result: PromiseSettledResult<object>): object | null {
  return result.status === 'fulfilled' ? result.value : null;
}

export class UserBff {
  constructor(private readonly clients: UserBffClients) {}

  async dashboard(subject: UserSubject, context: ServiceRequestContext): Promise<{
    messages: object | null;
    partial: string[];
    recentTasks: object | null;
    wallet: object | null;
  }> {
    const [wallet, tasks, messages] = await Promise.allSettled([
      this.clients.wallet.get(subject, context),
      this.clients.tasks.get(subject, context),
      this.clients.messages.get(subject, context),
    ]);
    const partial: string[] = [];
    if (wallet.status === 'rejected') partial.push('wallet');
    if (tasks.status === 'rejected') partial.push('recentTasks');
    if (messages.status === 'rejected') partial.push('messages');
    return {
      messages: settledValue(messages),
      partial,
      recentTasks: settledValue(tasks),
      wallet: settledValue(wallet),
    };
  }
}
