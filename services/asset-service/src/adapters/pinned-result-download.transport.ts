import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import type { RequestOptions } from 'node:https';
import { isIP } from 'node:net';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { ResultImportError, type ResultDownloadTransport } from '../application/result-import.service.js';

export interface StreamingResultSink {
  putStream(input: {
    destinationKey: string;
    contentType: string;
    maxBytes: bigint;
    stream: Readable;
  }): Promise<{ contentType: string; sizeBytes: bigint; checksum?: string }>;
  delete(destinationKey: string): Promise<void>;
}

export interface PinnedRequestInput {
  url: URL;
  address: string;
  family: 4 | 6;
  hostname: string;
  servername: string;
  timeoutMs: number;
  signal: AbortSignal;
}

export interface PinnedResponse extends Readable {
  statusCode?: number | undefined;
  headers: Record<string, string | string[] | undefined>;
}

export type PinnedRequest = (input: PinnedRequestInput) => Promise<PinnedResponse>;
export type HttpsRequestImplementation = (
  url: URL,
  options: RequestOptions,
  onResponse: (response: IncomingMessage) => void,
) => ClientRequest;

/** HTTPS-only downloader that pins the connected address selected from a fully validated DNS answer. */
export class PinnedResultDownloadTransport implements ResultDownloadTransport {
  readonly #sink: StreamingResultSink;
  readonly #resolve: typeof lookup;
  readonly #requestPinned: PinnedRequest;
  readonly #totalTimeoutMs: number;

  constructor(input: { sink: StreamingResultSink; resolve?: typeof lookup; requestPinned?: PinnedRequest; totalTimeoutMs?: number }) {
    this.#sink = input.sink;
    this.#resolve = input.resolve ?? lookup;
    this.#requestPinned = input.requestPinned ?? createPinnedHttpsRequest();
    this.#totalTimeoutMs = input.totalTimeoutMs ?? 30_000;
    if (!Number.isFinite(this.#totalTimeoutMs) || this.#totalTimeoutMs <= 0) throw new Error('totalTimeoutMs must be positive');
  }

  async copy(input: {
    sourceUrl: URL;
    destinationKey: string;
    maxBytes: bigint;
    allowedHosts: string[];
  }): Promise<{ contentType: string; sizeBytes: bigint; checksum?: string }> {
    const deadline = Date.now() + this.#totalTimeoutMs;
    let current = input.sourceUrl;
    for (let redirects = 0; redirects <= 2; redirects += 1) {
      assertUrl(current, input.allowedHosts);
      const addresses = await beforeDeadline(this.#resolve(current.hostname, { all: true, verbatim: true }), deadline);
      if (addresses.length === 0 || addresses.some((answer) => !isGloballyRoutableAddress(answer.address))) {
        throw new ResultImportError('RESULT_URL_PRIVATE_ADDRESS', 'Result host resolves to a prohibited address');
      }
      const selected = addresses[0];
      if (selected === undefined) throw new ResultImportError('RESULT_URL_PRIVATE_ADDRESS', 'No usable result address');
      const requestController = new AbortController();
      const response = await beforeDeadline(this.#requestPinned({
        url: current,
        address: selected.address,
        family: selected.address.includes(':') ? 6 : 4,
        hostname: current.hostname,
        servername: current.hostname,
        timeoutMs: remainingMs(deadline),
        signal: requestController.signal,
      }), deadline, () => { requestController.abort(new ResultImportError('RESULT_IMPORT_FAILED', 'Result download timed out')); });
      if (response.statusCode !== undefined && response.statusCode >= 300 && response.statusCode < 400) {
        response.destroy();
        const location = singleHeader(response.headers.location);
        if (location === undefined || redirects === 2) {
          throw new ResultImportError('RESULT_REDIRECT_NOT_ALLOWED', 'Result redirect is not permitted');
        }
        current = new URL(location, current);
        continue;
      }
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        response.destroy();
        throw new ResultImportError('RESULT_IMPORT_FAILED', 'Result source could not be downloaded');
      }
      const contentType = singleHeader(response.headers['content-type'])?.split(';', 1)[0]?.trim().toLowerCase();
      if (contentType === undefined || contentType.length === 0) {
        response.destroy();
        throw new ResultImportError('RESULT_INTEGRITY_MISMATCH', 'Result source has no content type');
      }
      const length = singleHeader(response.headers['content-length']);
      if (typeof length === 'string' && /^\d+$/.test(length) && BigInt(length) > input.maxBytes) {
        response.destroy();
        throw new ResultImportError('RESULT_INTEGRITY_MISMATCH', 'Result source exceeds its limit');
      }
      const limiter = new DownloadByteLimit(input.maxBytes);
      try {
        return await beforeDeadline(this.#sink.putStream({
          destinationKey: input.destinationKey,
          contentType,
          maxBytes: input.maxBytes,
          stream: response.pipe(limiter),
        }), deadline, () => response.destroy());
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined);
        try { await this.#sink.delete(input.destinationKey); } catch { /* durable AssetCleanup remains authoritative */ }
        if (error instanceof ResultImportError) throw error;
        throw new ResultImportError('RESULT_IMPORT_FAILED', 'Result source could not be streamed');
      }
    }
    throw new ResultImportError('RESULT_REDIRECT_NOT_ALLOWED', 'Result redirect limit exceeded');
  }
}

export function createPinnedHttpsRequest(
  requestImplementation: HttpsRequestImplementation = request,
): PinnedRequest {
  return (input) => new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => { input.signal.removeEventListener('abort', onAbort); };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy(error);
      reject(error);
    };
    const onAbort = () => { fail(input.signal.reason instanceof Error ? input.signal.reason : new ResultImportError('RESULT_IMPORT_FAILED', 'Result download aborted')); };
    const req: ClientRequest = requestImplementation(input.url, {
      method: 'GET',
      headers: { Accept: 'video/*,image/*,application/octet-stream' },
      // `agent: false` creates a one-shot socket. A global keep-alive pool must
      // never reuse a connection which predates this request's validated DNS answer.
      agent: false,
      rejectUnauthorized: true,
      servername: input.servername,
      lookup: (_hostname, _options, callback) => {
        callback(null, input.address, input.family);
      },
      timeout: input.timeoutMs,
    }, (response) => {
      if (settled) { response.destroy(); return; }
      settled = true;
      cleanup();
      resolve(response as PinnedResponse);
    });
    req.once('timeout', () => { fail(new ResultImportError('RESULT_IMPORT_FAILED', 'Result download timed out')); });
    req.once('error', (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    input.signal.addEventListener('abort', onAbort, { once: true });
    if (input.signal.aborted) onAbort();
    req.end();
  });
}

function singleHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

class DownloadByteLimit extends Transform {
  #received = 0n;

  constructor(private readonly maxBytes: bigint) { super(); }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#received += BigInt(chunk.byteLength);
    if (this.#received > this.maxBytes) {
      callback(new ResultImportError('RESULT_INTEGRITY_MISMATCH', 'Result source exceeds its limit'));
      return;
    }
    callback(null, chunk);
  }
}

function assertUrl(url: URL, allowedHosts: string[]): void {
  const allowed = new Set(allowedHosts.map((host) => new URL(`https://${host.trim().replace(/\.$/, '')}`).hostname.toLowerCase()));
  if (url.protocol !== 'https:' || url.port.length > 0 || url.username || url.password || url.hash || !allowed.has(url.hostname.toLowerCase().replace(/\.$/, ''))) {
    throw new ResultImportError('RESULT_REDIRECT_NOT_ALLOWED', 'Result redirect is not permitted');
  }
}

export function isGloballyRoutableAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isGlobalIpv4(address);
  if (family !== 6) return false;
  const groups = expandIpv6(address);
  if (groups === null) return false;
  const g6 = groups[6] ?? 0;
  const g7 = groups[7] ?? 0;
  const embeddedIpv4 = [g6 >>> 8, g6 & 255, g7 >>> 8, g7 & 255].map(String).join('.');
  // ISATAP embeds IPv4 in the last 32 bits. Reject any non-global embedded target.
  if (groups[5] === 0x5efe && !isGlobalIpv4(embeddedIpv4)) return false;
  const special = specialPurposeDecision(groups);
  if (special !== undefined) {
    // The registry marks 64:ff9b::/96 globally reachable, but its destination
    // is the embedded IPv4 address, which must independently be global.
    if (special && matchesIpv6Cidr(groups, '64:ff9b::', 96)) return isGlobalIpv4(embeddedIpv4);
    return special;
  }
  // Only ordinary RFC 4291 global-unicast space is eligible by default.
  return matchesIpv6Cidr(groups, '2000::', 3);
}

// IANA IPv6 Special-Purpose Address Registry, last updated 2025-10-09.
// Longest-prefix matching is required because 2001::/23 contains explicitly
// globally-reachable child allocations. Missing/blank/N/A reachability is false.
// https://www.iana.org/assignments/iana-ipv6-special-registry/
const IANA_IPV6_SPECIAL_PURPOSE: ReadonlyArray<readonly [string, number, boolean]> = [
  ['::1', 128, false], ['::', 128, false], ['::ffff:0:0', 96, false],
  ['64:ff9b::', 96, true], ['64:ff9b:1::', 48, false],
  ['100::', 64, false], ['100:0:0:1::', 64, false],
  ['2001::', 23, false], ['2001::', 32, false],
  ['2001:1::1', 128, true], ['2001:1::2', 128, true], ['2001:1::3', 128, true],
  ['2001:2::', 48, false], ['2001:3::', 32, true], ['2001:4:112::', 48, true],
  ['2001:10::', 28, false], ['2001:20::', 28, true], ['2001:30::', 28, true],
  ['2001:db8::', 32, false], ['2002::', 16, false], ['2620:4f:8000::', 48, true],
  ['3fff::', 20, false], ['5f00::', 16, false], ['fc00::', 7, false], ['fe80::', 10, false],
];

function specialPurposeDecision(groups: number[]): boolean | undefined {
  let decision: boolean | undefined;
  let longest = -1;
  for (const [prefix, prefixLength, globallyReachable] of IANA_IPV6_SPECIAL_PURPOSE) {
    if (prefixLength > longest && matchesIpv6Cidr(groups, prefix, prefixLength)) {
      decision = globallyReachable;
      longest = prefixLength;
    }
  }
  return decision;
}

function matchesIpv6Cidr(groups: number[], prefix: string, prefixLength: number): boolean {
  const prefixGroups = expandIpv6(prefix);
  if (prefixGroups === null) throw new Error(`Invalid embedded IPv6 prefix: ${prefix}`);
  const shift = BigInt(128 - prefixLength);
  return (ipv6Value(groups) >> shift) === (ipv6Value(prefixGroups) >> shift);
}

function ipv6Value(groups: number[]): bigint {
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

function remainingMs(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new ResultImportError('RESULT_IMPORT_FAILED', 'Result download timed out');
  return remaining;
}

async function beforeDeadline<T>(promise: Promise<T>, deadline: number, onTimeout?: () => void): Promise<T> {
  const timeoutMs = remainingMs(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new ResultImportError('RESULT_IMPORT_FAILED', 'Result download timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function isGlobalIpv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) || (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function expandIpv6(address: string): number[] | null {
  const [left, right] = address.toLowerCase().split('::');
  if (address.split('::').length > 2) return null;
  const toGroups = (part: string | undefined) => part === undefined || part.length === 0 ? [] : part.split(':').map((partValue) => /^[0-9a-f]{1,4}$/.test(partValue) ? Number.parseInt(partValue, 16) : Number.NaN);
  const before = toGroups(left);
  const after = toGroups(right);
  if (before.some(Number.isNaN) || after.some(Number.isNaN)) return null;
  if (right === undefined) return before.length === 8 ? before : null;
  const zeros = 8 - before.length - after.length;
  return zeros < 1 ? null : [...before, ...Array<number>(zeros).fill(0), ...after];
}
