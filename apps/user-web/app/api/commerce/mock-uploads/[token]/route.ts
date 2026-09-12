import { createHash } from 'node:crypto';

import {
  requireMutableAuthenticatedServerSession,
  SessionRefreshRequiredError,
} from '../../../../../lib/auth/server-session';
import { commerceOwnerIdFromPhone } from '../../../../../lib/commerce/identity';
import {
  createMockUploadReceipt,
  UploadBoundaryError,
  verifyMockUploadGrant,
} from '../../../../../lib/commerce/mock-upload-boundary';

const PRIVATE_HEADERS = {
  'cache-control': 'no-store, private',
  pragma: 'no-cache',
  vary: 'Cookie',
} as const;

export async function PUT(
  request: Request,
  context: { readonly params: Promise<{ readonly token: string }> },
): Promise<Response> {
  const requestUrl = new URL(request.url);
  const origin = request.headers.get('origin');
  const fetchSite = request.headers.get('sec-fetch-site');
  if (origin !== requestUrl.origin || (fetchSite !== null && fetchSite !== 'same-origin')) {
    return new Response(null, { headers: PRIVATE_HEADERS, status: 403 });
  }
  try {
    const session = await requireMutableAuthenticatedServerSession();
    const ownerId = commerceOwnerIdFromPhone(session.ownerId);
    const grant = verifyMockUploadGrant((await context.params).token);
    if (grant.ownerId !== ownerId)
      return new Response(null, { headers: PRIVATE_HEADERS, status: 404 });
    if (
      request.headers.get('content-type') !== grant.mimeType ||
      request.headers.get('x-upload-content-length') !== grant.sizeBytes ||
      (request.headers.get('content-length') !== null &&
        request.headers.get('content-length') !== grant.sizeBytes)
    ) {
      return new Response(null, { headers: PRIVATE_HEADERS, status: 400 });
    }
    const expected = BigInt(grant.sizeBytes);
    const reader = request.body?.getReader();
    if (!reader) return new Response(null, { headers: PRIVATE_HEADERS, status: 400 });
    const hash = createHash('sha256');
    let actual = 0n;
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        done = true;
        continue;
      }
      actual += BigInt(chunk.value.byteLength);
      if (actual > expected) {
        await reader.cancel().catch(() => undefined);
        return new Response(null, { headers: PRIVATE_HEADERS, status: 400 });
      }
      hash.update(chunk.value);
    }
    if (actual !== expected) return new Response(null, { headers: PRIVATE_HEADERS, status: 400 });
    return Response.json(
      { receipt: createMockUploadReceipt(grant, hash.digest('hex')) },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      return Response.json(
        { code: 'SESSION_REFRESH_REQUIRED' },
        { headers: PRIVATE_HEADERS, status: 401 },
      );
    }
    const status = error instanceof UploadBoundaryError && error.code === 'EXPIRED' ? 410 : 401;
    return Response.json(
      { code: status === 410 ? 'UPLOAD_GRANT_EXPIRED' : 'UNAUTHENTICATED' },
      { headers: PRIVATE_HEADERS, status },
    );
  }
}
