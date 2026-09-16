import { BadRequestException, Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { PointsStringSchema, UuidSchema } from '@repo/contracts/common';
import type { WalletCommand } from '../application/wallet.service.js';
import { WalletService } from '../application/wallet.service.js';
import type { PostedLedgerTransaction } from '../application/ledger.repository.js';
import { AuthenticatedUserId } from './authenticated-user.decorator.js';
import { InternalAuthGuard, UserAuthGuard } from './internal-auth.guard.js';

interface WalletCommandBody {
  businessKey: unknown;
  userId: unknown;
  points: unknown;
  traceId: unknown;
  reason?: unknown;
}

interface TransactionResponse {
  transactionId: string;
  businessKey: string;
  kind: string;
  userId: string;
  points: string;
  traceId: string;
  createdAt: string;
}

function invalid(code: string): BadRequestException & { code: string } {
  return Object.assign(new BadRequestException(code), { code });
}

function parseCommand(body: WalletCommandBody): WalletCommand {
  const points = PointsStringSchema.safeParse(body.points);
  if (!points.success || points.data === '0') throw invalid('INVALID_POINTS');
  const userId = UuidSchema.safeParse(body.userId);
  if (!userId.success) throw invalid('INVALID_USER_ID');
  if (
    typeof body.businessKey !== 'string' ||
    body.businessKey.length < 8 ||
    body.businessKey.length > 120
  ) {
    throw invalid('INVALID_BUSINESS_KEY');
  }
  if (typeof body.traceId !== 'string' || !/^[a-f0-9]{32,64}$/.test(body.traceId)) {
    throw invalid('INVALID_TRACE_ID');
  }
  if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.length > 240)) {
    throw invalid('INVALID_REASON');
  }
  return {
    businessKey: body.businessKey,
    userId: userId.data,
    points: BigInt(points.data),
    traceId: body.traceId,
    ...(body.reason === undefined ? {} : { reason: body.reason }),
  };
}

function transactionResponse(transaction: PostedLedgerTransaction): TransactionResponse {
  return {
    transactionId: transaction.transactionId,
    businessKey: transaction.businessKey,
    kind: transaction.kind,
    userId: transaction.userId,
    points: transaction.points.toString(),
    traceId: transaction.traceId,
    createdAt: transaction.createdAt.toISOString(),
  };
}

@Controller('internal/wallet')
@UseGuards(InternalAuthGuard)
export class InternalWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Post('credit')
  async credit(@Body() body: WalletCommandBody): Promise<TransactionResponse> {
    return transactionResponse(await this.wallet.credit(parseCommand(body)));
  }

  @Post('reserve')
  async reserve(@Body() body: WalletCommandBody): Promise<TransactionResponse> {
    return transactionResponse(await this.wallet.reserve(parseCommand(body)));
  }

  @Post('settle')
  async settle(@Body() body: WalletCommandBody): Promise<TransactionResponse> {
    return transactionResponse(await this.wallet.settle(parseCommand(body)));
  }

  @Post('release')
  async release(@Body() body: WalletCommandBody): Promise<TransactionResponse> {
    return transactionResponse(await this.wallet.release(parseCommand(body)));
  }
}

@Controller('v1/wallet')
@UseGuards(UserAuthGuard)
export class UserWalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  async balance(@AuthenticatedUserId() userId: string) {
    const balance = await this.wallet.getBalance(userId);
    return {
      userId: balance.userId,
      available: balance.available.toString(),
      frozen: balance.frozen.toString(),
    };
  }

  @Get('transactions')
  async transactions(@AuthenticatedUserId() userId: string): Promise<TransactionResponse[]> {
    return (await this.wallet.listTransactions(userId)).map(transactionResponse);
  }
}
