import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { HEADERS, UuidSchema } from '@repo/contracts/common';
import type { RuntimeRequest } from './operations.js';

export const GATEWAY_IDENTITY_HEADERS = {
  userId: 'x-authenticated-user-id',
  timestamp: 'x-gateway-timestamp',
  requestId: 'x-gateway-request-id',
  signature: 'x-gateway-signature',
} as const;

export interface GatewayReplayStore {
  claim(input: {
    readonly requestId: string;
    readonly bodySha256: string;
    readonly receivedAt: Date;
    readonly expiresAt: Date;
  }): Promise<boolean>;
}

export class GatewayIdentityVerifier {
  constructor(
    private readonly secrets: readonly string[],
    private readonly replayStore: GatewayReplayStore,
    private readonly now: () => number = Date.now,
    private readonly maximumSkewSeconds = 300,
  ) {
    if (
      secrets.length < 1 ||
      secrets.length > 2 ||
      secrets.some((secret) => Buffer.byteLength(secret) < 32)
    ) {
      throw new Error('INVALID_GATEWAY_IDENTITY_HMAC_SECRETS');
    }
  }

  async verify(request: RuntimeRequest): Promise<string | null> {
    const userId = singleHeader(request, GATEWAY_IDENTITY_HEADERS.userId);
    const timestamp = singleHeader(request, GATEWAY_IDENTITY_HEADERS.timestamp);
    const requestId = singleHeader(request, GATEWAY_IDENTITY_HEADERS.requestId);
    const signature = singleHeader(request, GATEWAY_IDENTITY_HEADERS.signature);
    if (
      !UuidSchema.safeParse(userId).success ||
      !isGatewayRequestId(requestId) ||
      timestamp === undefined ||
      signature === undefined
    ) {
      return null;
    }
    if (!/^\d{10}$/.test(timestamp) || !/^[a-f0-9]{64}$/.test(signature)) return null;
    const nowSeconds = Math.floor(this.now() / 1_000);
    const timestampSeconds = Number(timestamp);
    if (Math.abs(nowSeconds - timestampSeconds) > this.maximumSkewSeconds) return null;
    const url = new URL(request.path, 'http://generation.invalid');
    const bodyHash = createHash('sha256').update(request.rawBody).digest('hex');
    const canonical = [
      userId,
      timestamp,
      requestId,
      request.method.toUpperCase(),
      `${url.pathname}${url.search}`,
      bodyHash,
      `idempotency-key:${singleHeader(request, HEADERS.idempotencyKey) ?? ''}`,
      `last-event-id:${singleHeader(request, 'last-event-id') ?? ''}`,
      `x-trace-id:${singleHeader(request, HEADERS.traceId) ?? ''}`,
    ].join('\n');
    const expected = this.secrets.map((secret) =>
      createHmac('sha256', secret).update(canonical).digest('hex'),
    );
    const matches = expected.map((candidate) => safeEqual(signature, candidate));
    if (!matches.some(Boolean)) return null;
    const claimed = await this.replayStore.claim({
      requestId,
      bodySha256: bodyHash,
      receivedAt: new Date(this.now()),
      expiresAt: new Date((timestampSeconds + this.maximumSkewSeconds) * 1_000),
    });
    return claimed ? (userId as string) : null;
  }
}

function isGatewayRequestId(value: string | undefined): value is string {
  return (
    value !== undefined &&
    (/^[a-f0-9]{32}$/.test(value) ||
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value))
  );
}

export function validBearerAuthorization(
  value: string | string[] | undefined,
  tokens: readonly string[],
): boolean {
  if (typeof value !== 'string') return false;
  const matches = tokens.map((token) => safeEqual(value, `Bearer ${token}`));
  return matches.some(Boolean);
}

export function requiredSecretList(
  environment: Readonly<Record<string, string | undefined>>,
  listName: string,
  legacyName: string,
): readonly string[] {
  const list = environment[listName];
  const legacy = environment[legacyName];
  if (list !== undefined && legacy !== undefined) throw new Error(`${listName}_CONFLICT`);
  const source = list ?? legacy;
  const values = source?.split(',').map((value) => value.trim()) ?? [];
  if (
    values.length < 1 ||
    values.length > 2 ||
    values.some((value) => value.length < 32) ||
    new Set(values).size !== values.length
  ) {
    throw new Error(`${listName}_REQUIRED`);
  }
  return values;
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function singleHeader(request: RuntimeRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? undefined : value;
}
