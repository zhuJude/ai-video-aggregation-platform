import { Body, Controller, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { QuoteService } from '../application/quote.service.js';
import { RuleVersionStore, type RuleKind } from '../application/rule-version.store.js';
import { parseQuoteRequest } from './quote-input.js';

const DraftRuleSchema = z.object({
  id: z.string().min(1),
  version: z.int().positive(),
  effectiveAt: z.iso.datetime(),
  payload: z.record(z.string(), z.unknown()),
});
const PublishSchema = z.object({ publishedBy: z.string().min(1) });
const RollbackSchema = z.object({
  id: z.string().min(1),
  effectiveAt: z.iso.datetime(),
  publishedBy: z.string().min(1),
});

@Controller('internal/admin/routing')
export class AdminRoutingController {
  constructor(
    private readonly rules: RuleVersionStore,
    private readonly quotes: QuoteService,
  ) {}

  private create(kind: RuleKind, body: unknown) {
    return this.rules.createDraft(kind, DraftRuleSchema.parse(body));
  }

  private publish(kind: RuleKind, version: string, body: unknown) {
    return this.rules.publish(
      kind,
      z.coerce.number().int().positive().parse(version),
      PublishSchema.parse(body).publishedBy,
    );
  }

  private rollback(kind: RuleKind, version: string, body: unknown) {
    return this.rules.rollback(
      kind,
      z.coerce.number().int().positive().parse(version),
      RollbackSchema.parse(body),
    );
  }

  @Post('price-rules')
  createPriceRule(@Body() body: unknown) {
    return this.create('PRICE', body);
  }

  @Post('price-rules/:version/publish')
  publishPriceRule(@Param('version') version: string, @Body() body: unknown) {
    return this.publish('PRICE', version, body);
  }

  @Post('price-rules/:version/rollback')
  rollbackPriceRule(@Param('version') version: string, @Body() body: unknown) {
    return this.rollback('PRICE', version, body);
  }

  @Post('route-policies')
  createRoutePolicy(@Body() body: unknown) {
    return this.create('ROUTE', body);
  }

  @Post('route-policies/:version/publish')
  publishRoutePolicy(@Param('version') version: string, @Body() body: unknown) {
    return this.publish('ROUTE', version, body);
  }

  @Post('route-policies/:version/rollback')
  rollbackRoutePolicy(@Param('version') version: string, @Body() body: unknown) {
    return this.rollback('ROUTE', version, body);
  }

  @Post('simulate')
  simulate(@Body() body: unknown) {
    return this.quotes.simulate(parseQuoteRequest(body));
  }
}
