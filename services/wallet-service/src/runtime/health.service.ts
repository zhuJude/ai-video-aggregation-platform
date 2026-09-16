export interface DatabaseHealthPort {
  ping(): Promise<void>;
}

export class WalletHealthService {
  constructor(private readonly database: DatabaseHealthPort) {}

  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async readiness(): Promise<{
    ready: boolean;
    checks: { postgres: 'up' | 'down' };
  }> {
    try {
      await this.database.ping();
      return { ready: true, checks: { postgres: 'up' } };
    } catch {
      return { ready: false, checks: { postgres: 'down' } };
    }
  }
}
