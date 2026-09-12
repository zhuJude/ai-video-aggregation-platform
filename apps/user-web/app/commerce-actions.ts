'use server';

import {
  AuthenticationRequiredError,
  requireMutableAuthenticatedServerSession,
  SessionRefreshRequiredError,
} from '../lib/auth/server-session';
import { commerceGateway } from '../lib/commerce/gateway';
import {
  classifyCommerceCommandError,
  parseAssetPage,
  parseOrderCreateResult,
  parseSignedAssetUrl,
} from '../lib/commerce/runtime';
import type {
  AssetListItem,
  CommandOutcome,
  OrderCreateResult,
  SignedAssetUrl,
} from '../lib/commerce/types';

type ActionResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly outcome: CommandOutcome };

function outcome(error: unknown): CommandOutcome {
  if (error instanceof SessionRefreshRequiredError) return 'SESSION_REFRESH_REQUIRED';
  if (error instanceof AuthenticationRequiredError) return 'DEFINITIVE_FAILURE';
  return classifyCommerceCommandError(error);
}

async function authenticated<T>(run: (ownerId: string) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const session = await requireMutableAuthenticatedServerSession();
    return { ok: true, data: await run(session.ownerId) };
  } catch (error) {
    return { ok: false, outcome: outcome(error) };
  }
}

export async function requestAssetAccessAction(
  assetId: string,
  purpose: 'PREVIEW' | 'DOWNLOAD',
): Promise<ActionResult<SignedAssetUrl>> {
  return authenticated(async (ownerId) =>
    parseSignedAssetUrl(await commerceGateway.requestAssetAccess(assetId, purpose, { ownerId })),
  );
}

export async function uploadAssetAction(
  input: { readonly name: string; readonly size: number; readonly type: string },
  idempotencyKey: string,
): Promise<ActionResult<AssetListItem>> {
  return authenticated(async (ownerId) => {
    const page = parseAssetPage({
      items: [
        await commerceGateway.uploadAsset(input, {
          idempotencyKey,
          ownerId,
          signal: new AbortController().signal,
          onProgress: () => undefined,
        }),
      ],
      pageInfo: {},
    });
    const asset = page.items[0];
    if (!asset) throw new Error('INVALID_UPLOAD_RESULT');
    return asset;
  });
}

export async function renameAssetAction(
  assetId: string,
  name: string,
  idempotencyKey: string,
): Promise<ActionResult<AssetListItem>> {
  return authenticated(async (ownerId) => {
    const page = parseAssetPage({
      items: [await commerceGateway.renameAsset(assetId, name, { idempotencyKey, ownerId })],
      pageInfo: {},
    });
    const asset = page.items[0];
    if (!asset) throw new Error('INVALID_RENAME_RESULT');
    return asset;
  });
}

export async function deleteAssetAction(
  assetId: string,
  idempotencyKey: string,
): Promise<ActionResult<{ readonly accepted: true }>> {
  return authenticated(async (ownerId) => {
    const value = await commerceGateway.deleteAsset(assetId, { idempotencyKey, ownerId });
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).join(',') !== 'accepted' ||
      !('accepted' in value) ||
      value.accepted !== true
    ) {
      throw new Error('INVALID_DELETE_RESULT');
    }
    return { accepted: true };
  });
}

export async function createOrderAction(
  input: { readonly packageId?: string; readonly customAmountMinor?: string },
  idempotencyKey: string,
): Promise<ActionResult<OrderCreateResult>> {
  return authenticated(async (ownerId) =>
    parseOrderCreateResult(await commerceGateway.createOrder(input, { idempotencyKey, ownerId })),
  );
}

export async function createInvoiceAction(
  input: {
    readonly orderIds: readonly string[];
    readonly title: string;
    readonly taxNumber: string;
    readonly email: string;
  },
  idempotencyKey: string,
): Promise<ActionResult<{ readonly id: string; readonly status: 'SUBMITTED' }>> {
  return authenticated(async (ownerId) => {
    const value = await commerceGateway.createInvoice(input, { idempotencyKey, ownerId });
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'id,status' ||
      !('id' in value) ||
      typeof value.id !== 'string' ||
      !('status' in value) ||
      value.status !== 'SUBMITTED'
    ) {
      throw new Error('INVALID_INVOICE_RESULT');
    }
    return { id: value.id, status: 'SUBMITTED' };
  });
}
