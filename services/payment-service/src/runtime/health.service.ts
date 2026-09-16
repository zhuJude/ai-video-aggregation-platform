export interface DatabaseHealthPort {
  ping(): Promise<void>;
}

export interface PaymentCertificateHealthPort {
  isAvailable(): Promise<boolean>;
}

export class PaymentHealthService {
  constructor(
    private readonly database: DatabaseHealthPort,
    private readonly certificate: PaymentCertificateHealthPort,
  ) {}

  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  async readiness(): Promise<{
    ready: boolean;
    checks: { postgres: 'up' | 'down'; paymentCertificate: 'up' | 'down' };
  }> {
    const [database, certificate] = await Promise.all([
      this.database.ping().then(
        () => true,
        () => false,
      ),
      this.certificate.isAvailable().then(
        (available) => available,
        () => false,
      ),
    ]);
    return {
      ready: database && certificate,
      checks: {
        postgres: database ? 'up' : 'down',
        paymentCertificate: certificate ? 'up' : 'down',
      },
    };
  }
}
