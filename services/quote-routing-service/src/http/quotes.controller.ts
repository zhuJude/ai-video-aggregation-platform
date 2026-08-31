import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { QuoteService, type QuoteSnapshot } from '../application/quote.service.js';
import { parseQuoteRequest } from './quote-input.js';

function quoteResponse(quote: QuoteSnapshot) {
  return {
    ...quote,
    quotedPoints: quote.quotedPoints.toString(),
    costEstimatePoints: quote.costEstimatePoints.toString(),
    createdAt: quote.createdAt.toISOString(),
    expiresAt: quote.expiresAt.toISOString(),
  };
}

@Controller('v1/quotes')
export class QuotesController {
  constructor(private readonly quotes: QuoteService) {}

  @Post()
  async create(@Body() body: unknown) {
    return quoteResponse(await this.quotes.create(parseQuoteRequest(body)));
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    return quoteResponse(await this.quotes.get(id));
  }
}
