import {
  AuthenticationRequiredError,
  requireMutableAuthenticatedServerSession,
  SessionRefreshRequiredError,
} from '../../../../../lib/auth/server-session';
import { commerceOwnerIdFromPhone } from '../../../../../lib/commerce/identity';
import {
  createMockUploadReceipt,
  UploadBoundaryError,
  verifyMockUploadGrant,
  verifyMockUploadRecoveryGrant,
} from '../../../../../lib/commerce/mock-upload-boundary';
import {
  MockObjectStoreError,
  getStoredMockUploadSha,
  storeMockUpload,
} from '../../../../../lib/commerce/mock-object-store';

const PRIVATE_HEADERS = {
  'cache-control': 'no-store, private',
  pragma: 'no-cache',
  vary: 'Cookie',
} as const;

function uncertainResponse(): Response {
  return Response.json(
    { outcome: 'UNCERTAIN', code: 'UPLOAD_UNCERTAIN' },
    { headers: PRIVATE_HEADERS, status: 503 },
  );
}

function storeErrorResponse(error: MockObjectStoreError): Response {
  if (error.outcome === 'UNCERTAIN') {
    return Response.json(
      { outcome: 'UNCERTAIN', code: `UPLOAD_${error.code}` },
      { headers: PRIVATE_HEADERS, status: error.code === 'COMMAND_PENDING' ? 409 : 503 },
    );
  }
  const contentMismatch = error.code === 'CONTENT_MISMATCH';
  return Response.json(
    { code: contentMismatch ? 'UPLOAD_CONTENT_MISMATCH' : 'UPLOAD_REJECTED' },
    { headers: PRIVATE_HEADERS, status: contentMismatch ? 415 : 400 },
  );
}

export async function GET(
  _request: Request,
  context: { readonly params: Promise<{ readonly token: string }> },
): Promise<Response> {
  try {
    const session = await requireMutableAuthenticatedServerSession();
    const ownerId = commerceOwnerIdFromPhone(session.ownerId);
    const grant = verifyMockUploadRecoveryGrant((await context.params).token);
    if (grant.ownerId !== ownerId) {
      return new Response(null, { headers: PRIVATE_HEADERS, status: 404 });
    }
    const sha256 = await getStoredMockUploadSha(grant);
    if (!sha256) return new Response(null, { headers: PRIVATE_HEADERS, status: 204 });
    return Response.json(
      { state: 'STORED', receipt: createMockUploadReceipt(grant, sha256) },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      return Response.json(
        { code: 'SESSION_REFRESH_REQUIRED' },
        { headers: PRIVATE_HEADERS, status: 401 },
      );
    }
    if (error instanceof MockObjectStoreError) return storeErrorResponse(error);
    if (error instanceof UploadBoundaryError) {
      const status = error.code === 'EXPIRED' ? 410 : 401;
      return Response.json(
        { code: status === 410 ? 'UPLOAD_GRANT_EXPIRED' : 'UNAUTHENTICATED' },
        { headers: PRIVATE_HEADERS, status },
      );
    }
    if (error instanceof AuthenticationRequiredError) {
      return Response.json({ code: 'UNAUTHENTICATED' }, { headers: PRIVATE_HEADERS, status: 401 });
    }
    return uncertainResponse();
  }
}

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
    if (!request.body) return new Response(null, { headers: PRIVATE_HEADERS, status: 400 });
    const sha256 = await storeMockUpload(grant, request.body);
    return Response.json(
      { receipt: createMockUploadReceipt(grant, sha256) },
      { headers: PRIVATE_HEADERS },
    );
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      return Response.json(
        { code: 'SESSION_REFRESH_REQUIRED' },
        { headers: PRIVATE_HEADERS, status: 401 },
      );
    }
    if (error instanceof MockObjectStoreError) {
      return storeErrorResponse(error);
    }
    if (error instanceof UploadBoundaryError) {
      const status = error.code === 'EXPIRED' ? 410 : 401;
      return Response.json(
        { code: status === 410 ? 'UPLOAD_GRANT_EXPIRED' : 'UNAUTHENTICATED' },
        { headers: PRIVATE_HEADERS, status },
      );
    }
    if (error instanceof AuthenticationRequiredError) {
      return Response.json({ code: 'UNAUTHENTICATED' }, { headers: PRIVATE_HEADERS, status: 401 });
    }
    return uncertainResponse();
  }
}
