'use client';

import { parseUploadReceiptResponse, parseUploadSessionGrant } from './runtime';
import { coordinateSessionRefresh } from '../auth/client-session';
import type { UploadSessionGrant } from './types';

export class UploadTransportError extends Error {
  readonly outcome:
    'DEFINITIVE_FAILURE' | 'LOGIN_REQUIRED' | 'SESSION_REFRESH_REQUIRED' | 'UNCERTAIN';

  constructor(outcome: UploadTransportError['outcome']) {
    super(outcome);
    this.outcome = outcome;
  }
}

export async function uploadAssetBytesWithSessionRefresh(
  grant: UploadSessionGrant,
  file: File,
  options: {
    readonly signal: AbortSignal;
    readonly onProgress: (percentage: number) => void;
  },
): Promise<string> {
  try {
    return await uploadAssetBytes(grant, file, options);
  } catch (error) {
    if (!(error instanceof UploadTransportError) || error.outcome !== 'SESSION_REFRESH_REQUIRED')
      throw error;
    if (!(await coordinateSessionRefresh())) throw new UploadTransportError('LOGIN_REQUIRED');
    return uploadAssetBytes(grant, file, options);
  }
}

function traceId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function uploadTimeoutMs(sizeBytes: number): number {
  const transferBudget = Math.ceil((sizeBytes / (128 * 1024)) * 1_000) + 30_000;
  return Math.min(2 * 60 * 60_000, Math.max(2 * 60_000, transferBudget));
}

export function uploadAssetBytes(
  rawGrant: UploadSessionGrant,
  file: File,
  options: {
    readonly signal: AbortSignal;
    readonly onProgress: (percentage: number) => void;
  },
): Promise<string> {
  const grant = parseUploadSessionGrant(rawGrant);
  if (
    file.name.length === 0 ||
    file.type !== grant.headers['content-type'] ||
    String(file.size) !== grant.headers['x-upload-content-length'] ||
    Date.parse(grant.expiresAt) <= Date.now() + 5_000
  ) {
    return Promise.reject(new UploadTransportError('DEFINITIVE_FAILURE'));
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (run: () => void) => {
      if (settled) return;
      settled = true;
      options.signal.removeEventListener('abort', abort);
      run();
    };
    const abort = () => {
      xhr.abort();
      finish(() => {
        reject(new DOMException('Upload aborted.', 'AbortError'));
      });
    };
    xhr.open('PUT', grant.url);
    xhr.withCredentials = true;
    xhr.timeout = uploadTimeoutMs(file.size);
    for (const [name, value] of Object.entries(grant.headers)) xhr.setRequestHeader(name, value);
    xhr.setRequestHeader('x-correlation-id', crypto.randomUUID());
    xhr.setRequestHeader('x-trace-id', traceId());
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      options.onProgress(Math.min(99, Math.floor((event.loaded / event.total) * 100)));
    });
    xhr.onload = () => {
      finish(() => {
        if (xhr.status === 200) {
          try {
            const parsed = parseUploadReceiptResponse(JSON.parse(xhr.responseText) as unknown);
            options.onProgress(100);
            resolve(parsed.receipt);
          } catch {
            reject(new UploadTransportError('UNCERTAIN'));
          }
          return;
        }
        if (xhr.status === 401) {
          try {
            const body = JSON.parse(xhr.responseText) as unknown;
            if (
              typeof body === 'object' &&
              body !== null &&
              !Array.isArray(body) &&
              Object.keys(body).join(',') === 'code' &&
              'code' in body &&
              body.code === 'SESSION_REFRESH_REQUIRED'
            ) {
              reject(new UploadTransportError('SESSION_REFRESH_REQUIRED'));
              return;
            }
          } catch {
            // The response is deliberately collapsed below.
          }
        }
        reject(
          new UploadTransportError(
            xhr.status === 400 ||
              xhr.status === 403 ||
              xhr.status === 404 ||
              xhr.status === 410 ||
              xhr.status === 415
              ? 'DEFINITIVE_FAILURE'
              : 'UNCERTAIN',
          ),
        );
      });
    };
    xhr.onerror = () => {
      finish(() => {
        reject(new UploadTransportError('UNCERTAIN'));
      });
    };
    xhr.ontimeout = () => {
      finish(() => {
        reject(new UploadTransportError('UNCERTAIN'));
      });
    };
    xhr.onabort = () => {
      finish(() => {
        reject(new DOMException('Upload aborted.', 'AbortError'));
      });
    };
    if (options.signal.aborted) abort();
    else {
      options.signal.addEventListener('abort', abort, { once: true });
      xhr.send(file);
    }
  });
}
