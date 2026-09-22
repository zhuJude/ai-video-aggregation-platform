import { randomBytes, randomUUID } from 'node:crypto';

export interface SupportUploadReservation {
  id: string;
  operationId: string;
  remoteOperationId: string;
  generation: number;
  fence: string;
  requestHash: string;
  ownershipToken: string;
  sessionId: string;
  assetId: string;
  ownerId: string;
  purpose: 'SUPPORT_TICKET';
  expiresAt: Date;
}

export type SupportUploadOutcome =
  | { outcome: 'RESERVED'; reservation: SupportUploadReservation }
  | { outcome: 'USED' | 'EXPIRED' | 'NOT_FOUND' };

export interface InternalAssetRepository {
  findAvailableAsset(assetId: string): Promise<{ id: string; ownerId: string } | null>;
  reserve(
    input: SupportUploadReserveInput & { id: string; ownershipToken: string; now: Date },
  ): Promise<SupportUploadOutcome>;
  finalize(input: SupportUploadMutationInput): Promise<boolean>;
  release(input: SupportUploadMutationInput): Promise<boolean>;
  lookup(remoteOperationId: string): Promise<SupportUploadReservation | null>;
}

export interface SupportUploadReserveInput {
  operationId: string;
  remoteOperationId: string;
  generation: number;
  fence: string;
  requestHash: string;
  idempotencyKey: string;
  sessionId: string;
  assetId: string;
  ownerId: string;
  purpose: 'SUPPORT_TICKET';
}

export type SupportUploadMutationInput = Pick<
  SupportUploadReservation,
  'operationId' | 'remoteOperationId' | 'generation' | 'fence' | 'requestHash' | 'ownershipToken'
>;

export class SupportUploadError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'RESERVATION_CONFLICT' | 'RESERVATION_NOT_FOUND') {
    super(code);
    this.name = 'SupportUploadError';
  }
}

export class InternalAssetService {
  constructor(
    private readonly repository: InternalAssetRepository,
    private readonly now: () => Date = () => new Date(),
    private readonly id: () => string = randomUUID,
    private readonly token: () => string = () => randomBytes(32).toString('base64url'),
  ) {}

  findAvailableAsset(assetId: string): Promise<{ id: string; ownerId: string } | null> {
    if (!uuid(assetId)) return Promise.resolve(null);
    return this.repository.findAvailableAsset(assetId);
  }

  reserve(input: SupportUploadReserveInput): Promise<SupportUploadOutcome> {
    validateReserve(input);
    return this.repository.reserve({
      ...input,
      id: this.id(),
      ownershipToken: this.token(),
      now: this.now(),
    });
  }

  async finalize(input: SupportUploadMutationInput): Promise<void> {
    validateMutation(input);
    if (!(await this.repository.finalize(input)))
      throw new SupportUploadError('RESERVATION_NOT_FOUND');
  }

  async release(input: SupportUploadMutationInput): Promise<void> {
    validateMutation(input);
    if (!(await this.repository.release(input)))
      throw new SupportUploadError('RESERVATION_NOT_FOUND');
  }

  lookup(remoteOperationId: string): Promise<SupportUploadReservation | null> {
    if (remoteOperationId.length === 0 || remoteOperationId.length > 255)
      return Promise.resolve(null);
    return this.repository.lookup(remoteOperationId);
  }
}

function validateReserve(input: SupportUploadReserveInput): void {
  if (
    input.operationId.length === 0 ||
    input.remoteOperationId.length === 0 ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    input.fence.length === 0 ||
    !/^[a-f0-9]{64}$/i.test(input.requestHash) ||
    input.idempotencyKey.length === 0 ||
    !uuid(input.sessionId) ||
    !uuid(input.assetId) ||
    !uuid(input.ownerId)
  )
    throw new SupportUploadError('INVALID_REQUEST');
}

function validateMutation(input: SupportUploadMutationInput): void {
  if (
    input.operationId.length === 0 ||
    input.remoteOperationId.length === 0 ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 0 ||
    input.fence.length === 0 ||
    !/^[a-f0-9]{64}$/i.test(input.requestHash) ||
    input.ownershipToken.length < 32
  )
    throw new SupportUploadError('INVALID_REQUEST');
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
