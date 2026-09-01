import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ServiceHealth } from '../operational/health.js';
import type { IdentityMetrics } from '../operational/metrics.js';

@Controller()
export class OperationsController {
  constructor(
    @Inject('SERVICE_HEALTH') private readonly health: ServiceHealth,
    @Inject('SERVICE_METRICS') private readonly metrics: IdentityMetrics,
  ) {}
  @Get('healthz')
  healthz(@Res() reply: FastifyReply): void {
    const result = this.health.liveness();
    reply.status(result.statusCode).send(result.body);
  }
  @Get('readyz')
  async readyz(@Res() reply: FastifyReply): Promise<void> {
    const result = await this.health.readiness();
    reply.status(result.statusCode).send(result.body);
  }
  @Get('metrics')
  async metricz(@Res() reply: FastifyReply): Promise<void> {
    reply.type('text/plain; version=0.0.4; charset=utf-8').send(await this.metrics.render());
  }
}
