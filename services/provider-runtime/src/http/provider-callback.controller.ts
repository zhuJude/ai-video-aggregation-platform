import { createHash } from 'node:crypto';
import { UuidSchema } from '@repo/contracts/common';
import { z } from 'zod';
import type { ObservableProviderStatus } from '../domain/provider-state.js';

const CanonicalCallbackSchema = z.strictObject({
  providerEventId: z.string().min(1).max(256),
  providerTaskId: z.string().min(1).max(512),
  sequence: z.int().nonnegative(),
  state: z.enum(['ACCEPTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED']),
  resultUrls: z.array(z.url()).max(32).optional(),
  errorCode: z.string().min(1).max(120).optional(),
});

export interface CanonicalProviderCallback {
  readonly providerEventId: string;
  readonly providerTaskId: string;
  readonly sequence: number;
  readonly state: ObservableProviderStatus;
  readonly resultUrls?: readonly string[];
  readonly errorCode?: string;
}

export interface ProviderCallbackAdapter {
  verifyCallback(input: {
    headers: Record<string, string>;
    body: unknown;
  }): Promise<{ readonly valid: boolean; readonly payload: unknown }>;
  normalizeCallback(input: { readonly payload: unknown }): Promise<unknown>;
}

export interface ProviderCallbackAdapterRegistry {
  resolve(providerId: string): Promise<ProviderCallbackAdapter | null>;
}

export interface ApplyCallbackInput extends CanonicalProviderCallback {
  readonly providerId: string;
  readonly payloadSha256: string;
  readonly receivedAt: Date;
  readonly inboxId: string;
  readonly outboxId: string;
}

export type ApplyCallbackResult = {
  readonly kind: 'APPLIED' | 'DUPLICATE' | 'OUT_OF_ORDER' | 'STATE_REGRESSION' | 'TERMINAL_IGNORED';
};

export interface CallbackRepository {
  apply(input: ApplyCallbackInput): Promise<ApplyCallbackResult>;
}

export class ProviderCallbackError extends Error {
  constructor(
    readonly code: string,
    readonly statusCode: number,
  ) {
    super(code);
    this.name = 'ProviderCallbackError';
  }
}

interface ProviderCallbackDependencies {
  readonly adapters: ProviderCallbackAdapterRegistry;
  readonly repository: CallbackRepository;
  readonly clock: { now(): Date };
  readonly ids: { next(): string };
}

export class ProviderCallbackService {
  constructor(private readonly dependencies: ProviderCallbackDependencies) {}

  async handle(input: {
    readonly providerId: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly rawBody: Uint8Array;
  }): Promise<ApplyCallbackResult> {
    if (!UuidSchema.safeParse(input.providerId).success)
      throw new ProviderCallbackError('INVALID_PROVIDER_ID', 400);
    if (!(input.rawBody instanceof Uint8Array))
      throw new ProviderCallbackError('RAW_CALLBACK_BODY_REQUIRED', 400);
    const adapter = await this.dependencies.adapters.resolve(input.providerId);
    if (adapter === null) throw new ProviderCallbackError('PROVIDER_NOT_FOUND', 404);

    // Signature verification intentionally receives the untouched byte array. Parsing and
    // normalization happen only after the adapter has authenticated those exact bytes.
    const verified = await adapter.verifyCallback({
      headers: { ...input.headers },
      body: input.rawBody,
    });
    if (!verified.valid) throw new ProviderCallbackError('INVALID_CALLBACK_SIGNATURE', 401);
    const normalized = CanonicalCallbackSchema.safeParse(
      await adapter.normalizeCallback({ payload: verified.payload }),
    );
    if (!normalized.success) throw new ProviderCallbackError('INVALID_CALLBACK_PAYLOAD', 400);
    return this.dependencies.repository.apply({
      providerEventId: normalized.data.providerEventId,
      providerTaskId: normalized.data.providerTaskId,
      sequence: normalized.data.sequence,
      state: normalized.data.state,
      ...(normalized.data.resultUrls === undefined
        ? {}
        : { resultUrls: normalized.data.resultUrls }),
      ...(normalized.data.errorCode === undefined ? {} : { errorCode: normalized.data.errorCode }),
      providerId: input.providerId,
      payloadSha256: createHash('sha256').update(input.rawBody).digest('hex'),
      receivedAt: this.dependencies.clock.now(),
      inboxId: this.dependencies.ids.next(),
      outboxId: this.dependencies.ids.next(),
    });
  }
}

export class ProviderCallbackController {
  constructor(private readonly service: ProviderCallbackService) {}

  async post(
    providerId: string,
    headers: Readonly<Record<string, string>>,
    rawBody: Uint8Array,
  ): Promise<{ readonly statusCode: 202; readonly body: { readonly outcome: string } }> {
    const result = await this.service.handle({ providerId, headers, rawBody });
    return { statusCode: 202, body: { outcome: result.kind } };
  }
}

export function callbackDeduplicationKey(executionId: string, providerEventId: string): string {
  const eventHash = createHash('sha256').update(providerEventId).digest('hex');
  return `${executionId}:callback:${eventHash}`;
}
