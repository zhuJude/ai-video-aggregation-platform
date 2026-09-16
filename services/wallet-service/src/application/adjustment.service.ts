import type {
  AdjustmentDirection,
  AdjustmentRequestRecord,
  FinancialControlRepository,
} from './financial-control.repository.js';
import type { WalletService } from './wallet.service.js';

interface AdjustmentAuthorization {
  canApprove(adminId: string): boolean | Promise<boolean>;
}

export interface RequestAdjustmentCommand {
  userId: string;
  direction: AdjustmentDirection;
  points: bigint;
  requestedBy: string;
  reason: string;
  traceId: string;
}

function domainError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export class AdjustmentService {
  constructor(
    private readonly repository: FinancialControlRepository,
    private readonly wallet: WalletService,
    private readonly authorization: AdjustmentAuthorization,
  ) {}

  request(command: RequestAdjustmentCommand): Promise<AdjustmentRequestRecord> {
    if (command.points <= 0n) throw domainError('INVALID_POINTS');
    if (command.reason.trim().length < 8) throw domainError('ADJUSTMENT_REASON_REQUIRED');
    return this.repository.createAdjustment({
      userId: command.userId,
      direction: command.direction,
      points: command.points,
      requestedBy: command.requestedBy,
      reason: command.reason,
      traceId: command.traceId,
    });
  }

  async approve(
    requestId: string,
    approvedBy: string,
    traceId: string,
  ): Promise<AdjustmentRequestRecord> {
    const request = await this.repository.getAdjustment(requestId);
    if (!request) throw domainError('ADJUSTMENT_NOT_FOUND');
    if (request.status === 'POSTED') return request;
    if (!(await this.authorization.canApprove(approvedBy))) {
      throw domainError('ADJUSTMENT_APPROVAL_FORBIDDEN');
    }
    if (request.requestedBy === approvedBy) throw domainError('DUAL_APPROVAL_REQUIRED');

    const approved = await this.repository.addAdjustmentApproval(requestId, approvedBy);
    if (approved.approvals.length < 2) return approved;

    const signedPoints = approved.direction === 'CREDIT' ? approved.points : -approved.points;
    const transaction = await this.wallet.adjust({
      businessKey: `adjustment:${approved.id}:apply`,
      userId: approved.userId,
      points: signedPoints,
      traceId,
      reason: approved.reason,
    });
    return this.repository.markAdjustmentPosted(approved.id, transaction.transactionId);
  }
}
