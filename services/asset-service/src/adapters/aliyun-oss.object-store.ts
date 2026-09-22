import { createHash } from 'node:crypto';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import OSS from 'ali-oss';
import type { ObjectStore } from '../ports/object-store.js';

const MAX_UPLOAD_EXPIRATION_SECONDS = 15 * 60;
const MAX_DOWNLOAD_EXPIRATION_SECONDS = 15 * 60;
const MAX_PREFIX_READ_BYTES = 32;

export interface StsCredentials {
  accessKeyId: string;
  accessKeySecret: string;
  securityToken: string;
}

export interface AliyunOssObjectStoreConfig {
  environment: 'local' | 'development' | 'test' | 'staging' | 'production';
  region: string;
  bucket: string;
  bucketAcl: 'private' | 'public-read';
  ramRoleArn: string;
  kmsKeyId: string;
  cdnBaseUrl: string;
  cdnAuthKeyReference: string;
  cdnAuthValiditySeconds: number;
  credentialProvider: (references: {
    ramRoleArn: string;
    kmsKeyId: string;
  }) => Promise<StsCredentials>;
  secretResolver: (kmsReference: string) => Promise<string>;
  now?: () => Date;
}

export class ObjectStoreConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjectStoreConfigurationError';
  }
}

export class AliyunOssObjectStore implements ObjectStore {
  readonly #config: AliyunOssObjectStoreConfig;
  readonly #cdnBaseUrl: URL;
  readonly #now: () => Date;

  constructor(config: AliyunOssObjectStoreConfig) {
    validateConfiguration(config);
    this.#config = config;
    this.#cdnBaseUrl = new URL(config.cdnBaseUrl);
    this.#now = config.now ?? (() => new Date());
  }

  async ping(): Promise<void> {
    const client = this.#makeClient(await this.#getStsCredentials());
    await client.getBucketInfo(this.#config.bucket);
  }

  async createUpload(input: {
    objectKey: string;
    contentType: string;
    maxBytes: bigint;
    expiresInSeconds: number;
  }): Promise<{ url: string; headers: Record<string, string> }> {
    validateObjectKey(input.objectKey);
    validateExpiration(input.expiresInSeconds, MAX_UPLOAD_EXPIRATION_SECONDS, 'upload');
    const maxBytes = toSafePositiveNumber(input.maxBytes, 'Upload size');
    const credentials = await this.#getStsCredentials();
    const client = this.#makeClient(credentials);
    const expiration = new Date(this.#now().getTime() + input.expiresInSeconds * 1_000);
    const policy = {
      expiration: expiration.toISOString(),
      conditions: [
        { bucket: this.#config.bucket },
        ['eq', '$key', input.objectKey],
        ['content-length-range', 1, maxBytes],
        ['eq', '$Content-Type', input.contentType],
        ['eq', '$x-oss-server-side-encryption', 'KMS'],
        ['eq', '$x-oss-server-side-encryption-key-id', this.#config.kmsKeyId],
        ['eq', '$x-oss-forbid-overwrite', 'true'],
      ],
    };
    const signature = client.calculatePostSignature(policy);
    const objectUrl = new URL(client.generateObjectUrl(input.objectKey));
    objectUrl.pathname = '/';
    objectUrl.search = '';
    objectUrl.hash = '';

    return {
      url: objectUrl.toString(),
      // ObjectStore's `headers` bag contains the required multipart form fields.
      // Callers must include every entry unchanged when submitting the POST form.
      headers: {
        key: input.objectKey,
        'Content-Type': input.contentType,
        OSSAccessKeyId: signature.OSSAccessKeyId,
        Signature: signature.Signature,
        policy: signature.policy,
        'x-oss-security-token': credentials.securityToken,
        'x-oss-server-side-encryption': 'KMS',
        'x-oss-server-side-encryption-key-id': this.#config.kmsKeyId,
        'x-oss-forbid-overwrite': 'true',
        success_action_status: '200',
      },
    };
  }

  async head(objectKey: string): Promise<{
    contentType: string;
    sizeBytes: bigint;
    checksum?: string;
  }> {
    validateObjectKey(objectKey);
    const client = this.#makeClient(await this.#getStsCredentials());
    const result = await client.head(objectKey);
    const contentType = getHeader(result.res.headers, 'content-type');
    const contentLength = getHeader(result.res.headers, 'content-length');
    if (contentType === undefined || contentLength === undefined || !/^\d+$/.test(contentLength)) {
      throw new Error('OSS HEAD response is missing valid content metadata');
    }
    const sha256 = getHeader(result.res.headers, 'x-oss-hash-sha256');
    const crc64 = getHeader(result.res.headers, 'x-oss-hash-crc64ecma');
    const checksum = sha256 ?? (crc64 === undefined ? undefined : `crc64:${crc64}`);
    return {
      contentType,
      sizeBytes: BigInt(contentLength),
      ...(checksum === undefined ? {} : { checksum }),
    };
  }

  async readPrefix(objectKey: string, maxBytes: number): Promise<Uint8Array> {
    validateObjectKey(objectKey);
    if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_PREFIX_READ_BYTES) {
      throw new Error(`Prefix read must be between 1 and ${String(MAX_PREFIX_READ_BYTES)} bytes`);
    }
    const client = this.#makeClient(await this.#getStsCredentials());
    const result = await client.get(objectKey, {
      headers: { Range: `bytes=0-${String(maxBytes - 1)}` },
    });
    const contentRange = getHeader(result.res.headers, 'content-range');
    if (!isBoundedPrefixResponse(contentRange, result.content.byteLength, maxBytes)) {
      throw new Error('OSS did not return the requested bounded object prefix');
    }
    return Uint8Array.from(result.content);
  }

  async createDownload(objectKey: string, expiresInSeconds: number): Promise<string> {
    validateObjectKey(objectKey);
    validateExpiration(expiresInSeconds, MAX_DOWNLOAD_EXPIRATION_SECONDS, 'download');
    if (expiresInSeconds !== this.#config.cdnAuthValiditySeconds) {
      throw new Error('Requested download expiration must equal the configured CDN TTL');
    }
    const secret = await this.#config.secretResolver(this.#config.cdnAuthKeyReference);
    if (!/^[A-Za-z0-9]{6,128}$/.test(secret)) {
      throw new ObjectStoreConfigurationError('Resolved CDN authentication key is invalid');
    }
    const url = new URL(this.#cdnBaseUrl.toString());
    url.pathname = joinUrlPath(url.pathname, objectKey);
    const expiresAt = Math.floor(this.#now().getTime() / 1_000);
    const authMaterial = `${url.pathname}-${String(expiresAt)}-0-0-${secret}`;
    const digest = createHash('md5').update(authMaterial, 'utf8').digest('hex');
    url.searchParams.set('auth_key', `${String(expiresAt)}-0-0-${digest}`);
    return url.toString();
  }

  async delete(objectKey: string): Promise<void> {
    validateObjectKey(objectKey);
    const client = this.#makeClient(await this.#getStsCredentials());
    await client.delete(objectKey);
  }

  /** Private KMS streaming sink used only by the pinned provider-result transport. */
  async putStream(input: {
    destinationKey: string;
    contentType: string;
    maxBytes: bigint;
    stream: Readable;
  }): Promise<{ sizeBytes: bigint; contentType: string; checksum?: string }> {
    validateObjectKey(input.destinationKey);
    const client = this.#makeClient(await this.#getStsCredentials());
    const limiter = new ByteLimitTransform(input.maxBytes);
    try {
      await client.putStream(input.destinationKey, input.stream.pipe(limiter), {
        mime: input.contentType,
        headers: {
          'x-oss-server-side-encryption': 'KMS',
          'x-oss-server-side-encryption-key-id': this.#config.kmsKeyId,
          'x-oss-forbid-overwrite': 'true',
        },
      });
      const stored = await this.head(input.destinationKey);
      if (stored.sizeBytes > input.maxBytes)
        throw new Error('Copied object exceeds the configured size limit');
      return stored;
    } catch (error) {
      input.stream.destroy(error instanceof Error ? error : undefined);
      try {
        await client.delete(input.destinationKey);
      } catch {
        /* durable cleanup is scheduled by the importer */
      }
      throw error;
    }
  }

  async #getStsCredentials(): Promise<StsCredentials> {
    const credentials = await this.#config.credentialProvider({
      ramRoleArn: this.#config.ramRoleArn,
      kmsKeyId: this.#config.kmsKeyId,
    });
    if (
      credentials.accessKeyId.length === 0 ||
      credentials.accessKeySecret.length === 0 ||
      credentials.securityToken.length === 0
    ) {
      throw new ObjectStoreConfigurationError('RAM role provider returned invalid STS credentials');
    }
    return credentials;
  }

  #makeClient(credentials: StsCredentials): OSS {
    return new OSS({
      region: this.#config.region,
      bucket: this.#config.bucket,
      accessKeyId: credentials.accessKeyId,
      accessKeySecret: credentials.accessKeySecret,
      stsToken: credentials.securityToken,
      secure: true,
    });
  }
}

class ByteLimitTransform extends Transform {
  readonly #maxBytes: bigint;
  #receivedBytes = 0n;

  constructor(maxBytes: bigint) {
    super();
    this.#maxBytes = maxBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#receivedBytes += BigInt(chunk.byteLength);
    if (this.#receivedBytes > this.#maxBytes) {
      callback(new Error('Source object exceeds the configured size limit'));
      return;
    }
    callback(null, chunk);
  }
}

function validateConfiguration(config: AliyunOssObjectStoreConfig): void {
  if (config.environment !== 'local' && config.bucketAcl === 'public-read') {
    throw new ObjectStoreConfigurationError(
      'public-read OSS buckets are forbidden outside local development',
    );
  }
  if (config.ramRoleArn.trim().length === 0) {
    throw new ObjectStoreConfigurationError('A RAM role ARN is required');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(config.kmsKeyId)) {
    throw new ObjectStoreConfigurationError('A resolved bare KMS key ID is required');
  }
  if (!isApprovedKmsReference(config.cdnAuthKeyReference)) {
    throw new ObjectStoreConfigurationError('A CDN authentication KMS reference is required');
  }
  if (
    !Number.isInteger(config.cdnAuthValiditySeconds) ||
    config.cdnAuthValiditySeconds < 1 ||
    config.cdnAuthValiditySeconds > MAX_DOWNLOAD_EXPIRATION_SECONDS
  ) {
    throw new ObjectStoreConfigurationError('CDN Type-A TTL must be between 1 and 900 seconds');
  }
  const cdnUrl = new URL(config.cdnBaseUrl);
  if (
    cdnUrl.protocol !== 'https:' ||
    cdnUrl.username.length > 0 ||
    cdnUrl.password.length > 0 ||
    cdnUrl.search.length > 0 ||
    cdnUrl.hash.length > 0
  ) {
    throw new ObjectStoreConfigurationError(
      'CDN base URL must be an HTTPS URL without credentials',
    );
  }
}

function isApprovedKmsReference(reference: string): boolean {
  return (
    /^kms:\/\/[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(reference) ||
    /^acs:kms:[a-z0-9-]+:\d+:(?:key|alias)\/[A-Za-z0-9._-]+$/i.test(reference)
  );
}

function validateExpiration(seconds: number, maxSeconds: number, operation: string): void {
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > maxSeconds) {
    throw new Error(`${operation} expiration must be between 1 and ${String(maxSeconds)} seconds`);
  }
}

function validateObjectKey(objectKey: string): void {
  if (
    objectKey.length === 0 ||
    objectKey.length > 1024 ||
    objectKey.startsWith('/') ||
    objectKey.includes('..') ||
    objectKey.includes('\\') ||
    objectKey.includes('\0')
  ) {
    throw new Error('Invalid OSS object key');
  }
}

function toSafePositiveNumber(value: bigint, label: string): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return Number(value);
}

function getHeader(
  headers: Record<string, string | number | undefined>,
  requestedName: string,
): string | undefined {
  const match = Object.entries(headers).find(([name]) => name.toLowerCase() === requestedName);
  return match?.[1] === undefined ? undefined : String(match[1]);
}

function isBoundedPrefixResponse(
  contentRange: string | undefined,
  receivedBytes: number,
  maxBytes: number,
): boolean {
  const match = /^bytes 0-(\d+)\/\d+$/i.exec(contentRange ?? '');
  return match !== null && receivedBytes <= maxBytes && Number(match[1]) + 1 === receivedBytes;
}

function joinUrlPath(basePath: string, objectKey: string): string {
  const base = basePath.endsWith('/') ? basePath.slice(0, -1) : basePath;
  const encodedKey = objectKey.split('/').map(encodeURIComponent).join('/');
  return `${base}/${encodedKey}`;
}
