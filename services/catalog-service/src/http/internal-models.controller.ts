import { timingSafeEqual } from 'node:crypto';
import {
  Body,
  type CanActivate,
  Controller,
  type ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { CatalogStore } from '../domain/catalog-store.js';

export const INTERNAL_SERVICE_TOKEN = Symbol('INTERNAL_SERVICE_TOKEN');

@Injectable()
export class InternalServiceAuthGuard implements CanActivate {
  constructor(@Inject(INTERNAL_SERVICE_TOKEN) private readonly expectedToken: string) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{
      headers: { authorization?: string | string[] };
    }>();
    const authorization = request.headers.authorization;
    const supplied = Array.isArray(authorization) ? authorization[0] : authorization;
    const expected = `Bearer ${this.expectedToken}`;
    if (!supplied || this.expectedToken.length === 0 || supplied.length !== expected.length) {
      throw new ForbiddenException('INTERNAL_SERVICE_AUTH_REQUIRED');
    }
    if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      throw new ForbiddenException('INTERNAL_SERVICE_AUTH_REQUIRED');
    }
    return true;
  }
}

@Controller('internal/models')
@UseGuards(InternalServiceAuthGuard)
export class InternalModelsController {
  constructor(private readonly store: CatalogStore) {}

  @Post(':id/disable')
  disable(@Param('id') id: string, @Body() body: unknown) {
    z.object({ reason: z.literal('MARGIN_BELOW_MINIMUM') }).parse(body);
    return this.store.updateModel(id, { status: 'DISABLED' });
  }
}
