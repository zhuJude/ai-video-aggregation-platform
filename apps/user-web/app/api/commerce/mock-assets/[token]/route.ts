import { Readable } from 'node:stream';

import {
  requireMutableAuthenticatedServerSession,
  SessionRefreshRequiredError,
} from '../../../../../lib/auth/server-session';
import {
  UploadBoundaryError,
  verifyMockAssetAccess,
} from '../../../../../lib/commerce/mock-upload-boundary';
import {
  findMockObject,
  openMockObjectContent,
} from '../../../../../lib/commerce/mock-object-store';

const PRIVATE_HEADERS = {
  'accept-ranges': 'bytes',
  'cache-control': 'no-store, private',
  pragma: 'no-cache',
  vary: 'Cookie',
  'x-content-type-options': 'nosniff',
} as const;

function rangeBounds(
  header: string | null,
  size: number,
): { readonly start: number; readonly end: number } | undefined | null {
  if (header === null) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return null;
  const first = match[1] ? Number(match[1]) : undefined;
  const second = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (second !== undefined && !Number.isSafeInteger(second))
  ) {
    return null;
  }
  if (first === undefined) {
    const suffix = second ?? 0;
    if (suffix <= 0) return null;
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  if (first < 0 || first >= size) return null;
  const end = Math.min(second ?? size - 1, size - 1);
  if (end < first) return null;
  return { start: first, end };
}

export async function GET(
  request: Request,
  context: { readonly params: Promise<{ readonly token: string }> },
): Promise<Response> {
  try {
    const session = await requireMutableAuthenticatedServerSession();
    const ownerId = session.ownerId;
    const access = verifyMockAssetAccess((await context.params).token);
    if (access.ownerId !== ownerId)
      return new Response(null, { headers: PRIVATE_HEADERS, status: 404 });
    const metadata = await findMockObject(access.assetId, ownerId);
    if (!metadata || metadata.storageKey !== access.storageKey) {
      return new Response(null, { headers: PRIVATE_HEADERS, status: 404 });
    }
    const opened = await openMockObjectContent(metadata).catch(() => undefined);
    if (!opened || opened.size <= 0) {
      return new Response(null, { headers: PRIVATE_HEADERS, status: 404 });
    }
    const range = rangeBounds(request.headers.get('range'), opened.size);
    if (range === null) {
      await opened.handle.close();
      return new Response(null, {
        headers: { ...PRIVATE_HEADERS, 'content-range': `bytes */${String(opened.size)}` },
        status: 416,
      });
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? opened.size - 1;
    const headers = new Headers(PRIVATE_HEADERS);
    headers.set('content-type', metadata.mimeType);
    headers.set('content-length', String(end - start + 1));
    headers.set(
      'content-disposition',
      `${access.purpose === 'DOWNLOAD' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(metadata.name)}`,
    );
    if (range)
      headers.set('content-range', `bytes ${String(start)}-${String(end)}/${String(opened.size)}`);
    const stream = Readable.toWeb(opened.handle.createReadStream({ start, end, autoClose: true }));
    return new Response(stream as ReadableStream<Uint8Array>, {
      headers,
      status: range ? 206 : 200,
    });
  } catch (error) {
    if (error instanceof SessionRefreshRequiredError) {
      return Response.json(
        { code: 'SESSION_REFRESH_REQUIRED' },
        { headers: PRIVATE_HEADERS, status: 401 },
      );
    }
    if (error instanceof UploadBoundaryError && error.code === 'EXPIRED') {
      return Response.json(
        { code: 'ASSET_ACCESS_EXPIRED' },
        { headers: PRIVATE_HEADERS, status: 410 },
      );
    }
    return new Response(null, { headers: PRIVATE_HEADERS, status: 404 });
  }
}
