import { Controller, Get, Header } from '@nestjs/common';

@Controller()
export class OperationalController {
  @Get('health/live')
  live() {
    return { status: 'ok', service: 'quote-routing-service' };
  }

  @Get('health/ready')
  ready() {
    return { status: 'ready', service: 'quote-routing-service' };
  }

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  metrics(): string {
    return [
      '# HELP service_up Whether the service process is available.',
      '# TYPE service_up gauge',
      'service_up{service="quote-routing-service"} 1',
      '',
    ].join('\n');
  }
}
