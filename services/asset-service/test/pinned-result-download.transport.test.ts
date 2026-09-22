/* eslint-disable @typescript-eslint/require-await -- focused async transport seams deliberately resolve synchronously. */
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  createPinnedHttpsRequest,
  PinnedResultDownloadTransport,
  isGloballyRoutableAddress,
} from '../src/adapters/pinned-result-download.transport.js';
import { ResultImportError } from '../src/application/result-import.service.js';

function response(statusCode: number, headers: Record<string, string>, chunks: Uint8Array[] = []) {
  return Object.assign(Readable.from(chunks), { statusCode, headers });
}

function hangingResponse(statusCode: number, headers: Record<string, string>) {
  return Object.assign(
    new Readable({
      read() {
        /* intentionally waits forever */
      },
    }),
    { statusCode, headers },
  );
}

describe('pinned result transport address policy', () => {
  it('disables socket pooling so a prior hostname connection cannot bypass fresh DNS pinning', async () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const fakeRequest = vi.fn(
      (
        _url: URL,
        options: Record<string, unknown>,
        onResponse: (value: ReturnType<typeof response>) => void,
      ) => {
        capturedOptions = options;
        onResponse(response(200, { 'content-type': 'video/mp4' }));
        return { once: vi.fn(), end: vi.fn(), destroy: vi.fn() };
      },
    );
    const pinned = createPinnedHttpsRequest(fakeRequest as never);
    await pinned({
      url: new URL('https://cdn.provider.cn/a'),
      address: '8.8.8.8',
      family: 4,
      hostname: 'cdn.provider.cn',
      servername: 'cdn.provider.cn',
      timeoutMs: 1_000,
      signal: new AbortController().signal,
    });
    expect(capturedOptions).toMatchObject({
      agent: false,
      servername: 'cdn.provider.cn',
      rejectUnauthorized: true,
    });
    const lookup = capturedOptions?.lookup as (
      hostname: string,
      options: unknown,
      callback: (error: null, address: string, family: number) => void,
    ) => void;
    const callback = vi.fn();
    lookup('cdn.provider.cn', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });

  it('destroys a request exactly once when the shared deadline expires before headers', async () => {
    const destroy = vi.fn();
    const fakeRequest = vi.fn(() => ({ once: vi.fn(), end: vi.fn(), destroy }));
    const pinned = createPinnedHttpsRequest(fakeRequest as never);
    const controller = new AbortController();
    const pending = pinned({
      url: new URL('https://cdn.provider.cn/a'),
      address: '8.8.8.8',
      family: 4,
      hostname: 'cdn.provider.cn',
      servername: 'cdn.provider.cn',
      timeoutMs: 1_000,
      signal: controller.signal,
    });
    const reason = new ResultImportError('RESULT_IMPORT_FAILED', 'deadline');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(destroy).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledWith(reason);
  });

  it('aborts a headerless pinned request at the transport total deadline without hanging', async () => {
    const aborted = vi.fn();
    const requestPinned = vi.fn(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              aborted();
              reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
            },
            { once: true },
          );
        }),
    );
    const sink = { putStream: vi.fn(), delete: vi.fn() };
    const transport = new PinnedResultDownloadTransport({
      sink: sink as never,
      resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }] as never),
      requestPinned: requestPinned as never,
      totalTimeoutMs: 10,
    });
    await expect(
      transport.copy({
        sourceUrl: new URL('https://cdn.provider.cn/a'),
        destinationKey: 'results/o/a',
        maxBytes: 10n,
        allowedHosts: ['cdn.provider.cn'],
      }),
    ).rejects.toMatchObject({ code: 'RESULT_IMPORT_FAILED' });
    expect(aborted).toHaveBeenCalledOnce();
    expect(sink.putStream).not.toHaveBeenCalled();
  });

  it.each([
    '127.0.0.1',
    '10.2.3.4',
    '100.64.0.1',
    '169.254.1.1',
    '172.16.0.1',
    '192.0.2.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '::',
    '::1',
    '::ffff:127.0.0.1',
    'fc00::1',
    'fe90::1',
    'fec0::1',
    'ff00::1',
    '2001:db8::1',
    '2002:0a00:0001::1',
    '64:ff9b::a9fe:a9fe',
    '64:ff9b:1::a9fe:a9fe',
    '::ffff:0:7f00:1',
    '100:0:0:1::1',
    '2001:100::1',
    '3fff:0fff:ffff::1',
  ])('rejects non-global address %s', (address) => {
    expect(isGloballyRoutableAddress(address)).toBe(false);
  });

  it('accepts a public IPv4 and IPv6 address', () => {
    expect(isGloballyRoutableAddress('8.8.8.8')).toBe(true);
    expect(isGloballyRoutableAddress('192.0.1.1')).toBe(true);
    expect(isGloballyRoutableAddress('198.51.99.1')).toBe(true);
    expect(isGloballyRoutableAddress('2606:4700:4700::1111')).toBe(true);
    expect(isGloballyRoutableAddress('2001:4860:4860::8888')).toBe(true);
    expect(isGloballyRoutableAddress('64:ff9b::808:808')).toBe(true);
    expect(isGloballyRoutableAddress('2001:1::1')).toBe(true);
    expect(isGloballyRoutableAddress('2001:3::1')).toBe(true);
    expect(isGloballyRoutableAddress('2001:20::1')).toBe(true);
    expect(isGloballyRoutableAddress('3ff0::1')).toBe(true);
    expect(isGloballyRoutableAddress('3fff:1000::1')).toBe(true);
  });

  it('pins the socket address while preserving TLS SNI and hostname', async () => {
    const requestPinned = vi.fn(async () =>
      response(200, { 'content-type': 'video/mp4', 'content-length': '4' }, [
        Uint8Array.of(1, 2, 3, 4),
      ]),
    );
    const sink = {
      putStream: vi.fn(async () => ({ contentType: 'video/mp4', sizeBytes: 4n })),
      delete: vi.fn(async () => undefined),
    };
    const transport = new PinnedResultDownloadTransport({
      sink,
      resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }] as never),
      requestPinned,
    });
    await transport.copy({
      sourceUrl: new URL('https://cdn.provider.cn/video.mp4'),
      destinationKey: 'results/owner/id',
      maxBytes: 4n,
      allowedHosts: ['cdn.provider.cn'],
    });
    expect(requestPinned).toHaveBeenCalledWith(
      expect.objectContaining({
        address: '8.8.8.8',
        family: 4,
        hostname: 'cdn.provider.cn',
        servername: 'cdn.provider.cn',
      }),
    );
  });

  it('rejects empty or mixed DNS answers before opening a socket', async () => {
    const requestPinned = vi.fn();
    const sink = { putStream: vi.fn(), delete: vi.fn() };
    for (const answers of [
      [],
      [
        { address: '8.8.8.8', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    ]) {
      const transport = new PinnedResultDownloadTransport({
        sink: sink as never,
        resolve: vi.fn(async () => answers as never),
        requestPinned,
      });
      await expect(
        transport.copy({
          sourceUrl: new URL('https://cdn.provider.cn/a'),
          destinationKey: 'results/o/a',
          maxBytes: 10n,
          allowedHosts: ['cdn.provider.cn'],
        }),
      ).rejects.toMatchObject({ code: 'RESULT_URL_PRIVATE_ADDRESS' });
    }
    expect(requestPinned).not.toHaveBeenCalled();
  });

  it('revalidates DNS on every redirect and rejects a third redirect', async () => {
    const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }] as never);
    const requestPinned = vi
      .fn()
      .mockResolvedValueOnce(response(302, { location: 'https://cdn.provider.cn/two' }))
      .mockResolvedValueOnce(response(302, { location: 'https://cdn.provider.cn/three' }))
      .mockResolvedValueOnce(response(302, { location: 'https://cdn.provider.cn/four' }));
    const transport = new PinnedResultDownloadTransport({
      sink: { putStream: vi.fn(), delete: vi.fn() } as never,
      resolve,
      requestPinned,
    });
    await expect(
      transport.copy({
        sourceUrl: new URL('https://cdn.provider.cn/one'),
        destinationKey: 'results/o/a',
        maxBytes: 10n,
        allowedHosts: ['cdn.provider.cn'],
      }),
    ).rejects.toMatchObject({ code: 'RESULT_REDIRECT_NOT_ALLOWED' });
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it('aborts an oversized stream and removes a partial destination', async () => {
    const stored: number[] = [];
    const source = response(200, { 'content-type': 'video/mp4' }, [
      Uint8Array.of(1, 2, 3),
      Uint8Array.of(4, 5, 6),
    ]);
    const sink = {
      putStream: vi.fn(async ({ stream }: { stream: Readable }) => {
        for await (const chunk of stream) stored.push(...(chunk as Uint8Array));
        return { contentType: 'video/mp4', sizeBytes: BigInt(stored.length) };
      }),
      delete: vi.fn(async () => {
        stored.length = 0;
      }),
    };
    const transport = new PinnedResultDownloadTransport({
      sink,
      resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }] as never),
      requestPinned: vi.fn(async () => source),
    });
    await expect(
      transport.copy({
        sourceUrl: new URL('https://cdn.provider.cn/a'),
        destinationKey: 'results/o/a',
        maxBytes: 5n,
        allowedHosts: ['cdn.provider.cn'],
      }),
    ).rejects.toMatchObject({ code: 'RESULT_INTEGRITY_MISMATCH' });
    expect(source.destroyed).toBe(true);
    expect(sink.delete).toHaveBeenCalledWith('results/o/a');
    expect(stored).toEqual([]);
  });

  it.each([
    [302, { location: 'https://evil.example/a' }, 'RESULT_REDIRECT_NOT_ALLOWED'],
    [500, {}, 'RESULT_IMPORT_FAILED'],
    [200, {}, 'RESULT_INTEGRITY_MISMATCH'],
    [200, { 'content-type': 'video/mp4', 'content-length': '11' }, 'RESULT_INTEGRITY_MISMATCH'],
  ] as const)(
    'destroys rejected HTTP response resources for status %s',
    async (statusCode, headers, code) => {
      const source = hangingResponse(statusCode, headers);
      const transport = new PinnedResultDownloadTransport({
        sink: { putStream: vi.fn(), delete: vi.fn() } as never,
        resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }] as never),
        requestPinned: vi.fn(async () => source),
      });
      await expect(
        transport.copy({
          sourceUrl: new URL('https://cdn.provider.cn/a'),
          destinationKey: 'results/o/a',
          maxBytes: 10n,
          allowedHosts: ['cdn.provider.cn'],
        }),
      ).rejects.toMatchObject({ code });
      expect(source.destroyed).toBe(true);
    },
  );

  it('destroys a slow infinite response and cleans its destination at the total deadline', async () => {
    const source = hangingResponse(200, { 'content-type': 'video/mp4' });
    const sink = {
      putStream: vi.fn(async ({ stream }: { stream: Readable }) => {
        for await (const chunk of stream) void chunk;
        return { contentType: 'video/mp4', sizeBytes: 0n };
      }),
      delete: vi.fn(async () => undefined),
    };
    const transport = new PinnedResultDownloadTransport({
      sink,
      resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }] as never),
      requestPinned: vi.fn(async () => source),
      totalTimeoutMs: 10,
    });
    await expect(
      transport.copy({
        sourceUrl: new URL('https://cdn.provider.cn/a'),
        destinationKey: 'results/o/a',
        maxBytes: 10n,
        allowedHosts: ['cdn.provider.cn'],
      }),
    ).rejects.toMatchObject({ code: 'RESULT_IMPORT_FAILED' });
    expect(source.destroyed).toBe(true);
    expect(sink.delete).toHaveBeenCalledWith('results/o/a');
  });
});
