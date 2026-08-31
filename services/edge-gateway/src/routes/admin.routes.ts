import { PublicApiError } from '@repo/service-kit';
import type { AdminSubject } from '../auth/subject.js';
import type { ServiceRequestContext } from '../clients/service-client.js';

export const ADMIN_ROUTE_TABLE = [
  {
    external: '/admin/v1/overview',
    internal: null,
    method: 'GET',
    permission: 'reporting:read',
    service: 'bff',
  },
  {
    external: '/admin/v1/wallet/adjustments',
    idempotency: 'point-adjustment',
    internal: '/admin/v1/wallet/adjustments',
    method: 'POST',
    permission: 'wallet:adjust',
    service: 'wallet',
  },
] as const;

export function requireAdminPermission(subject: AdminSubject, permission: string): void {
  if (!subject.permissions.includes(permission)) {
    throw new PublicApiError('FORBIDDEN', '无权执行此操作', false);
  }
}

export interface AdminOverviewClient {
  get(subject: AdminSubject, context: ServiceRequestContext): Promise<object>;
}

export interface AdminBffClients {
  readonly alerts: AdminOverviewClient;
  readonly reporting: AdminOverviewClient;
}

export class AdminBff {
  constructor(private readonly clients: AdminBffClients) {}

  async overview(
    subject: AdminSubject,
    context: ServiceRequestContext,
  ): Promise<{
    activeAlerts: object | null;
    partial: string[];
    reporting: object | null;
  }> {
    const [reporting, alerts] = await Promise.allSettled([
      this.clients.reporting.get(subject, context),
      this.clients.alerts.get(subject, context),
    ]);
    const partial: string[] = [];
    if (reporting.status === 'rejected') partial.push('reporting');
    if (alerts.status === 'rejected') partial.push('activeAlerts');
    return {
      activeAlerts: alerts.status === 'fulfilled' ? alerts.value : null,
      partial,
      reporting: reporting.status === 'fulfilled' ? reporting.value : null,
    };
  }
}
